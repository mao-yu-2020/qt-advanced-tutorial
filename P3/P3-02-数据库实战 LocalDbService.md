# P3-02 数据库实战：LocalDbService + Worker

> 本文基于 **Qt 6.8.3**。定位：P1-08 的实战篇，也是 P1-03「包装对象 + Worker」
> 模式在数据库场景的完整落地。下面这套封装来自实际项目（`apps/phoenix/db/`），
> 承载本地嵌入式 SQLite 库（教室配置、设备配对、班级花名册等五张表）。它解决的
> 核心问题就是 P1-08 的线程亲和红线：所有 SQL 都在专属子线程执行，结果回调
> 保证回到主线程。

## 1. 结构一览

```
LocalDbService（主线程，QObject，可被 parent 管理）
  │  拥有
  ├─▶ QThread _thread（构造时 start，析构时 quit+wait）
  └─▶ LocalDbServiceWorker _worker（无 parent，moveToThread 到子线程）
        └─▶ QSqlDatabase _db（固定连接名 "phoenix_local_db"）
```

调用方只跟 `LocalDbService` 打交道，接口全是"参数 + 回调"的异步形式：

```cpp
// LocalDbService.h —— 主线程包装对象
class LocalDbService : public QObject
{
    Q_OBJECT
public:
    /// 单回调承载成败两态：ok=false 时 error 为语义化错误描述
    using Ev_Result = std::function<void(bool ok, const QString &error)>;
    using Ev_Roster =
        std::function<void(bool ok, const QList<RosterRecord> &list, const QString &error)>;

    void open(Ev_Result cb);                                   // 打开并建表（幂等）
    void queryRoster(int classModelId, Ev_Roster cb);          // 查花名册
    void insertDevicePairings(const QList<DevicePairingRecord> &pairings,
                              Ev_Result cb);                   // 事务批量导入
    // ... 其余业务接口
private:
    QThread *_thread = nullptr;
    LocalDbServiceWorker *_worker = nullptr;
};
```

每个公开方法的实现都是一行转发——把参数和回调按值捕获，排队到 Worker 所在线程：

```cpp
void LocalDbService::queryRoster(int classModelId, Ev_Roster cb)
{
    QMetaObject::invokeMethod(_worker, [this, classModelId, cb]() {
        _worker->queryRoster(classModelId, cb);
    }, Qt::QueuedConnection);
}
```

注意这里捕获的是**值**（`classModelId`、`cb` 都拷贝进 lambda），不是 `this` 引用，所以即使包装对象在结果返回前析构，lambda 也不会悬垂（Worker 的生命周期由包装对象析构时统一收尾，见下）。

## 2. Worker：连接与 SQL 只活在子线程

```cpp
LocalDbServiceWorker::LocalDbServiceWorker(QThread *thread)
    : QObject(nullptr)   // 强制无 parent：Qt 禁止有 parent 的对象跨线程 move
{
    moveToThread(thread);
    QMetaObject::invokeMethod(this, &LocalDbServiceWorker::init,
                              Qt::QueuedConnection);  // init 排队到子线程执行
}
```

两个关键细节：

1. **构造时无 parent + moveToThread**：Qt 规定有 parent 的对象不能跨线程移动，所以 Worker 强制 `QObject(nullptr)`。
2. **init 排队执行**：构造函数还在主线程跑，`init()`（确定库文件路径、建目录）通过 `invokeMethod(this, ..., QueuedConnection)` 推迟到子线程事件循环里执行。同理，`open()` 也是业务方之后调用的，天然也在子线程——这样 `QSqlDatabase::addDatabase()` 和 `open()` 都发生在子线程，满足线程亲和。

Worker 内部持有连接，且用固定连接名避免和默认连接混淆：

```cpp
const char kConnectionName[] = "phoenix_local_db";  // 全进程唯一

void LocalDbServiceWorker::open(Ev_Result cb)
{
    // ... 迁移旧库、路径检查 ...
    if (!_db.isValid())
        _db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"),
                                        QString::fromLatin1(kConnectionName));
    _db.setDatabaseName(_dbPath);
    if (!_db.open()) {
        postResult(std::move(cb), false,
                   QStringLiteral("打开数据库失败：%1").arg(_db.lastError().text()));
        return;
    }
    // PRAGMA 外键开关、查 sqlite_master 只建缺失表、增量补列迁移 ...
    _opened = true;
    postResult(std::move(cb), true, {});
}
```

## 3. 结果回主线程：postXxx 编组

SQL 在子线程执行完，结果不能直接调回调（回调里的代码多半要动 UI）。Worker 统一用 `invokeMethod(qApp, ..., QueuedConnection)` 把结果编组回主线程：

```cpp
void LocalDbServiceWorker::postResult(Ev_Result cb, bool ok, const QString &error)
{
    QMetaObject::invokeMethod(qApp, [cb = std::move(cb), ok, error]() {
        if (cb)
            cb(ok, error);
    }, Qt::QueuedConnection);
}
```

## 4. 销毁顺序

```cpp
LocalDbService::~LocalDbService()
{
    // worker 无 parent 且运行在子线程，deleteLater 在其线程随事件循环退出前释放
    _worker->deleteLater();
    _thread->quit();
    _thread->wait();
}
```

`deleteLater` → `quit` → `wait` 的顺序保证 Worker（连同其中的 `QSqlDatabase`）在它自己的线程里析构，连接的创建、使用、销毁全程不出子线程。

## 5. 这套封装为什么是对的

对照一些常见的错误封装方式，可以看清这套设计好在哪：

- **不把 `QSqlQuery` 往外返回**。`QSqlQuery` 内部绑定连接，一旦跨线程传出就违反线程亲和；项目里 `QSqlQuery` 永远是 Worker 方法内的局部变量，跨线程传递的只有 `QList<RosterRecord>` 这类纯数据结构（`DbTypes.h` 里的 POD 记录）。
- **不靠 `QThread::currentThread() == thread()` 做线程检查**。对象刚构造时 `thread()` 还是主线程，`moveToThread` 之后才变，这类自检时机上就是错的；正确做法是像本封装一样，从结构上保证"所有 SQL 入口都在 Worker 方法里"，让错误在编译期 / 评审期就不可能发生。
- **回调按值捕获 + QueuedConnection**，不需要 `QPointer` 守卫回调目标——回调本身是 `std::function`，由调用方保证自己活着；worker 一侧捕获的是数据副本，天然无悬垂。
- **错误语义化**：SQL 层的 `lastError().text()` 在 Worker 内被翻译成业务能看懂的描述（如"座位号已存在"），UI 层拿到的 `error` 可以直接提示。


## 6. 小结

```
 LocalDbService 封装要点回顾
 ├─ 形态：主线程包装对象（无线程代码）+ 子线程 Worker
 │   独占连接（P1-03 模式一的直接应用）
 ├─ Worker：无 parent、构造即 moveToThread、init/open
 │   排队到子线程（连接创建/使用/销毁全程同线程）
 ├─ 跨线程只传纯数据（记录结构体），QSqlQuery 永不出
 │   Worker
 ├─ 结果经 invokeMethod(qApp, Queued) 编组回主线程；
 │   单回调承载 ok + 语义化 error 两态
 ├─ 连接名固定唯一；析构 deleteLater → quit → wait
 └─ 结构性防错：所有 SQL 入口都在 Worker 方法里，
     让错误在评审期就不可能发生
```

**进阶指引**

- 线程亲和红线的原理——见 **P1-08**；Worker 模式的完整规则（init 时机、异步接口、三件套）——见 **P1-03**；
- 基本 SQL 操作速查（prepare/事务/lastError）——见 **P1-08 §3**。
