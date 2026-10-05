# P3-01 日志实战：spdlog 异步封装

> 本文基于 **Qt 6.8.3**。定位：P1-04 的实战篇——主线讲了 Qt 自带日志系统，
> 本篇看一个真实项目（云课堂，Windows / Qt 6.8）怎么落地：不直接用 qDebug()
> 裸奔，而是基于 spdlog 封装了一个 teach_log 动态库（`common/shared/logging/`）。

## 1. 为什么不直接用 qDebug()

qDebug() 适合开发期调试，但要支撑发布后的事后排查就力不从心了：

- 同步写 stderr / 调试器，**阻塞调用线程**，高频日志会拖慢业务；
- 没有文件落盘与轮转能力，程序一关日志就没了；
- 无法按类别拆分文件，所有消息混在一个输出流里，排查问题全靠肉眼翻。

spdlog 正好补齐这些短板：异步写盘、按大小轮转、多 sink。整体结构如下：

```
 业务代码                      teach_log 库                  落盘
 ┌─────────────┐   TLOG_INFO(...)  ┌────────────┐   异步线程池
 │ 业务调用 TLOG │ ───────────────▶│ TeachLogger │─(队列8192,─┐
 ├─────────────┤                   │  单例封装    │ 1后台线程)│
 │ qDebug/...   │── qInstallMessage│ spdlog 封装 │           ▼
 │ (被自动捕获)  │   Handler 拦截   └─────┬──────┘   ┌──────────────┐
 └─────────────┘                        │          │ teachcloud.log│
        每条消息带文件/行号               ├─────────▶│  5MB × 3 轮转 │
        (QT_MESSAGELOGCONTEXT)           │          ├──────────────┤
                                         └─────────▶│ network.log   │
                                      网络分类双写   │  5MB × 3 轮转 │
                                                     └──────────────┘
```

## 2. 关键接口

TeachLogger 是个单例管理类，对外只暴露三个操作加一组宏：

```cpp
class TEACH_LOG_EXPORT TeachLogger : public QObject
{
public:
    // 初始化日志系统，dirUrl 为空时使用默认日志目录
    Q_INVOKABLE bool init(const QUrl &dirUrl = QUrl());

    // 设置日志级别：trace / debug / info / warn / error / critical / off
    Q_INVOKABLE void setLevel(const QString &level);

    // 强制刷新所有日志到磁盘（崩溃前、退出前调用）
    Q_INVOKABLE void flush();

    // 获取 C++ 使用的 spdlog logger 实例
    static std::shared_ptr<spdlog::logger> spdLogger();
};

// C++ 便捷宏，底层走 spdlog 的 fmt 风格格式化
#define TLOG_INFO(...)   do { if (auto l = TeachLogger::spdLogger()) l->info(__VA_ARGS__); } while(0)
#define TLOG_WARN(...)   do { if (auto l = TeachLogger::spdLogger()) l->warn(__VA_ARGS__); } while(0)
#define TLOG_ERROR(...)  do { if (auto l = TeachLogger::spdLogger()) l->error(__VA_ARGS__); } while(0)
// ... TLOG_TRACE / TLOG_DEBUG / TLOG_CRITICAL 同理
```

使用示例：

```cpp
TLOG_INFO("User {} logged in at {}", userId, QDateTime::currentDateTime().toString());
```

## 3. 初始化：异步 + 轮转 + Qt 消息捕获

初始化时创建异步线程池（队列 8192、1 个后台线程），主 logger 挂两个 sink——5MB × 3 轮转的 rotating_file_sink，外加一个 Windows 下专用的 qt_message_sink（把 spdlog 输出转回 Qt 原生消息，从而显示在 Qt Creator 的应用程序输出窗口）：

```cpp
// 异步线程池：队列 8192，1 个后台线程
spdlog::init_thread_pool(8192, 1);

std::vector<spdlog::sink_ptr> sinks;
// 文件 sink：5MB 轮转，保留 3 个备份
sinks.push_back(std::make_shared<spdlog::sinks::rotating_file_sink_mt>(
    logFile.toStdString(), 1024 * 1024 * 5, 3));
// Windows 下经 Qt 原生消息系统输出到 Qt Creator 输出窗口
sinks.push_back(std::make_shared<qt_message_sink_mt>());

_logger = std::make_shared<spdlog::async_logger>(
    "teachcloud", sinks.begin(), sinks.end(),
    spdlog::thread_pool(), spdlog::async_overflow_policy::block);
```

同时通过 qInstallMessageHandler 安装拦截器，把系统里所有 qDebug() / qWarning() / qCritical() 也一并收进 spdlog 落盘——这样第三方库或老代码里的 qDebug 也不会丢。拦截器里有个细节：用 thread_local 标志 g_inSpdlogSinkOutput 防循环转发（spdlog 往 Qt 输出时会再触发 handler）。

## 4. 分类独立文件：定点排查

该项目的日志规范是"完善性优先，足以支撑事后排查"，其中一条关键设计是**分类输出到独立文件**。网络模块用 Q_LOGGING_CATEGORY 定义了 lcNetwork（类别名 `teachcloud.network`），拦截器识别到这个类别的消息后，除了写主日志，还额外写一份到独立的 network.log：

```cpp
// 网络分类日志额外写入独立的 network.log（主日志中仍保留一份）
if (context.category && std::strcmp(context.category, kNetworkLogCategory) == 0) {
    if (auto networkLogger = g_networkLoggerCached) {
        logToLogger(networkLogger.get(), type, formatted);
    }
}
```

这样做的好处很实际：网络问题高发且消息量大，单独一个文件，排查网络问题时不用在主日志的海量消息里翻，直接打开 network.log 定点查看。

日志能带上源文件和行号，靠的就是前文说的 QT_MESSAGELOGCONTEXT——项目编译时定义了它，拦截器里 `context.file` / `context.line` 才有值，落盘格式形如 `[Qt] 消息内容 (main.cpp:42)`。

## 5. WindowsDumpHandler：崩溃现场保护

日志只能记录崩溃"之前"的事，崩溃瞬间本身要靠 dump。teach_log 库里还有一个 WindowsDumpHandler，通过 SetUnhandledExceptionFilter 注册全局未处理异常过滤器，崩溃时先用 TeachLogger 刷盘保住日志，再用 MiniDumpWriteDump 把 minidump 写到 crashes 目录（文件名带时间戳和进程 ID）：

```cpp
int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);

    WindowsDumpHandler dumpHandler;
    dumpHandler.install(QCoreApplication::applicationDirPath() + "/crashes");
    // ...
}
```

"日志 + dump"组合起来就是完整的事后排查闭环：dump 告诉你崩在哪条指令、调用栈是什么，日志告诉你崩之前业务走到了哪一步。

## 6. 落盘位置

TeachLogger::init() 不传目录时，默认把日志写到应用程序目录下的 logs 子目录（也支持传入自定义目录）；dump 文件默认写到应用程序目录下的 crashes 子目录。部署到用户机器后，收集问题时直接取这两个目录即可。

## 7. 小结

| 场景 | 建议 |
| --- | --- |
| 开发期临时调试、小工具 | qDebug() / qCDebug() 足够，配合过滤规则和 qSetMessagePattern |
| 需要按模块开关日志 | 自定义 QLoggingCategory + 过滤规则（代码 / 环境变量 / 配置文件） |
| 正式发布的项目 | spdlog 等专业日志库封装：异步写盘、轮转、按分类独立文件 |
| 发布后事后排查 | 日志（带 QT_MESSAGELOGCONTEXT 上下文）+ 崩溃 dump 双管齐下 |

Qt 自带日志系统的核心价值在于"类别 + 等级"的开关模型和可拦截的输出管线，它是学习日志系统设计的好样本；而真正上生产，建议像实战章节那样站在 spdlog 的肩膀上，同时用 qInstallMessageHandler 把 Qt 世界的消息也统一收编进来。
