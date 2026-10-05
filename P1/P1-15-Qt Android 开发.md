# P1-15 Qt Android 开发

> 本文基于 **Qt 6.8.3**，全部使用 Qt 6 API（`QJniObject`、`QtAndroidPrivate`、
> `QNativeInterface::QAndroidApplication`），Qt 5 写法不再展开。本篇是主线精简
> 指南：读完能独立完成"环境 → 真机跑通 → 签名发布 → 调通一次 Java 互调"。
> 自定义 Activity、JNI 动态注册、JNI_OnLoad 等深挖内容见 P3-06。

## 1. Qt 与 Android 的关系

先建立一个心智模型：Android 的界面单位是 Activity，而 Qt 的控件树由自己的绘制引擎渲染。Qt for Android 的结构是——**一个主 Activity（`QtActivity`）承载 Qt 的全部绘制和事件**：

```
  Android 世界（Activity 栈）        Qt 世界（绘制引擎）
 ┌───────────────────────┐      ┌───────────────────────┐
 │  自定义 Java Activity  │      │                       │
 ├───────────────────────┤      │   ┌───────────────┐   │
 │  QtActivity（主）      │◀────▶│   │ QML / Widget  │   │
 │  Qt 绘制与事件在此     │ 绘制 │   │ 控件树         │   │
 ├───────────────────────┤      │   └──────┬────────┘   │
 │  Launcher ...         │      │          ↓            │
 └───────────────────────┘      │   Qt 绘制引擎          │
         Activity 栈            └───────────────────────┘
```

拿到主 Activity 的 Qt 6 方式：`QNativeInterface::QAndroidApplication::activity()`（或 `context()`）。

一句大实话：**要开发 Qt for Android，你绕不开 Android 开发本身**——Gradle、Manifest、权限模型、Activity 生命周期都是 Android 的规则，Qt 只是把 C++/QML 接进来。Qt Android 适合"软件要多平台运行"的场景；纯 Android 应用它不是最优选。

## 2. 环境搭建

三样东西：**JDK、Android SDK（含 cmdline-tools）、NDK**。版本必须配套，Qt 6.8 的官方对应（已与 [Qt for Android | Qt 6.8](https://doc.qt.io/qt-6.8/android.html) 核对）：

| 组件 | Qt 6.8 要求 |
| --- | --- |
| JDK | 17 |
| NDK | r26b / r27c（26.1.10909125 / 27.2.12479018） |
| 目标 Android | API 28 ~ 36（Android 9 ~ 16） |
| Gradle / AGP | 8.14.3 / 8.10.1 |

配置步骤：

```
 ① 装 JDK 17
 ② 装 Android Studio（或命令行工具）→ 下载 SDK Platform +
    cmdline-tools + NDK（在 SDK Manager 勾选对应版本）
 ③ Qt Creator → 首选项 → 设备 → Android：
    填 JDK 位置 + SDK 路径 → 自动检测 NDK 并创建套件
 ④ 连真机（开 USB 调试）→ 选 Android 套件编译运行
```

三个高发坑：

1. **Gradle 下载失败**（国内网络）：构建目录 `android-build/gradle/wrapper/gradle-wrapper.properties` 里把 `distributionUrl` 换成国内源（如腾讯镜像 `https://mirrors.cloud.tencent.com/gradle/`）；下载中断残留时删掉 `C:\Users\<你>\.gradle` 重下。每个项目有独立 wrapper，要分别设置；
2. **NDK 版本不匹配**：官方建议与 Qt 库构建时的 NDK 版本一致，否则可能出现符号缺失；
3. **SDK cmdline-tools 版本不匹配**：Android Studio 默认装的是最新版 cmdline-tools，**太新了反而与 JDK 17 不兼容**（Qt 的 Android 构建调用它会报错）。解法：在 SDK Manager 里勾选"显示包详情"，安装与 JDK 17 匹配的旧版本（如 5.0 / 与 Qt 6.8 对应的版本），然后到 `cmdline-tools/` 目录把它重命名为 `latest`，让 Qt 用上这份匹配的版本。

## 3. 构建、部署与签名

Qt 把 Gradle 构建包进了自己的流程：**androiddeployqt** 负责把 Qt 库、你的 so、资源、清单打包交给 Gradle 产出 APK：

```
 CMake 构建 → libapp_xxx.so（各 ABI）
      │
      ▼ androiddeployqt：拷贝 Qt 依赖、生成/合并
      │   AndroidManifest、准备 Gradle 工程
      ▼
 Gradle → APK（未签名的 release 需再签名）
```

- **debug 构建**自动用 debug 证书签名，可直接安装；
- **release APK 必须签名**才能安装。JDK 自带的两个工具搞定：

```shell
# ① 生成证书（keystore，妥善保管，丢失无法更新应用）
keytool -genkey -keystore my-release-key.keystore -alias my_alias \
        -keyalg RSA -keysize 4096 -validity 10000

# ② 签名
jarsigner -sigalg MD5withRSA -digestalg SHA1 \
        -keystore my-release-key.keystore \
        -signedjar app-signed.apk android-build-release-unsigned.apk my_alias
```

（Qt Creator 的"构建 Android APK"步骤里也可以直接勾选 keystore 签名。）要上架 Play 商店则需 AAB 格式，构建时勾选"构建 Android 应用包（AAB）"。

## 4. 调试手段

### adb 三板斧

`adb` 在 `SDK/platform-tools/` 下：

```shell
adb devices          # 查看已连接设备
adb install app.apk  # 安装
adb logcat           # 查看设备日志（Qt 的 qDebug 输出在里头）★
```

USB 不可用时走**无线调试**：开发者选项 → 无线调试 → 配对码，`adb pair ip:port` 配对后即可无线连接。注意无线调试安装 App 仍需在开发者选项里打开"USB 安装/无线安装"权限。

### LLDB 断点调试

Android 的 native 调试器是 LLDB（早年是 GDB）。流程：开发者选项打开 **USB 调试 + 等待调试程序** → Qt Creator 按 F5 → 设备弹出 "wait for debugger"，耐心等调试器附加（时长与设备性能强相关）。

一个实用技巧：LLDB 附加时会收到线程挂起信号（SIGSTOP），要一直点继续很烦。在调试器设置的"额外的启动命令"里加：

```plain
process handle SIGSTOP -n true -p false -s false
```

## 5. 项目结构与 AndroidManifest

新项目里看不到 Android 文件——首次编译时 Qt 在 `android-build/` 输出目录里生成整套 Gradle 工程。**推荐把 android/ 目录纳入项目管理**而不是改输出目录（会被覆盖）：

```
 项目根/
 └─ android/                  ← QT_ANDROID_PACKAGE_SOURCE_DIR 指向这里
     ├─ AndroidManifest.xml   ← 清单：权限、Activity、meta-data
     ├─ build.gradle
     ├─ gradle.properties
     ├─ gradle/wrapper/...
     └─ res/values/libs.xml
```

CMake 里挂上（Qt 6 方式）：

```cmake
set_target_properties(appTarget PROPERTIES
    QT_ANDROID_PACKAGE_SOURCE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/android)
```

Manifest 的关键项（Qt 6 生成的清单已大幅精简，不再有 Qt 5 时代那堆 ministro meta-data）：

```xml
<manifest package="org.example.myapp" ...>
    <!-- 权限声明：运行时申请的前提是这里先声明 ★ -->
    <uses-permission android:name="android.permission.INTERNET"/>
    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES"/>

    <application ...>
        <activity android:name="org.qtproject.qt6.android.bindings.QtActivity"
                  android:exported="true" ...>
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
            <meta-data android:name="android.app.lib_name" android:value="myapp"/>
        </activity>
    </application>
</manifest>
```

- 包名决定 R 类的生成位置，自定义 Java 代码引用资源时路径要对；
- `QtActivity` 就是 §1 说的主 Activity；要加自己的 Activity 在此声明（见 P3-06）。

### 运行时权限

Android 的 dangerous 权限**只在 Manifest 声明不够，必须运行时申请**（Manifest 未声明则申请时连对话框都不弹，静默失败）。Qt 6 的申请方式：

- **QPermission**（Qt 6.5+，官方推荐）：覆盖相机、定位、蓝牙、麦克风等已定义权限；
- **`QtAndroidPrivate::requestPermission()`**（技术预览）：覆盖存储类等 QPermission 未覆盖的权限（`READ_MEDIA_*` 等）。需包含私有头 `<QtCore/private/qandroidextras_p.h>`。

```cpp
#include <QtCore/private/qandroidextras_p.h>

// 按 SDK 版本区分权限组（Android 13+ 用 READ_MEDIA_*）
auto result = QtAndroidPrivate::requestPermission(
        QStringLiteral("android.permission.READ_MEDIA_IMAGES"));
result.waitForFinished();
if (result.result() != QtAndroidPrivate::Authorized) {
    // 被拒：降级处理
}
```

## 6. C++ 与 Java 互调（QJniObject 基础）

Qt 6 里 `QAndroidJniObject` 改名 `QJniObject`（QtCore 内），`QAndroidJniEnvironment` 改名 `QJniEnvironment`。C++ 调 Java 的要素：**全限定类名（`/` 分隔）+ JNI 方法签名**。

```cpp
#include <QJniObject>

// 调用静态方法：String TestClass.fromNumber(int x)
QJniObject str = QJniObject::callStaticObjectMethod(
        "org/example/TestClass",
        "fromNumber",
        "(I)Ljava/lang/String;",       // ← JNI 签名：(参数)返回值
        10);
qDebug() << str.toString();
```

签名速查（结构 `(参数)返回值`，对象类型 `L全限定名;`，数组前缀 `[`）：

```
 基本类型： Z boolean | B byte | C char | S short
           I int | J long | F float | D double | V void
 对象：     Ljava/lang/String;   Ljava/lang/Object;
 数组：     [I（int[]）  [Ljava/lang/String;（String[]）
 示例：     "(I)Ljava/lang/String;"           int → String
           "(Ljava/lang/String;I)V"          String,int → void
```

两个方向与更深的主题，本篇点到为止、详见 P3-06：

- **Java 回调 C++**：`RegisterNatives` 动态注册 + `JNI_OnLoad` 最佳注册时机（P3-06 有完整实现与时序图）；
- **自定义 Activity**：无法用 C++ 创建 Activity，必须写 Java + Manifest 声明 + `QtAndroidPrivate::startActivity()` 跳转与结果回传（P3-06）；
- **异常处理**：JNI 调用可能抛 Java 异常，`QJniEnvironment` 检查清除——有异常挂起时继续 JNI 调用是不安全的。

## 7. 常见坑速查

```
 Qt Android 常见坑
 ├─ Gradle 下载失败 → wrapper 换国内源 + 清 .gradle
 ├─ NDK 版本不匹配 → 与 Qt 官方构建版本对齐（符号缺失）
 ├─ 权限静默失败 → Manifest 没声明；或该权限要运行时申请
 ├─ release 装不上 → 未签名；或签名证书与已装版本不一致
 ├─ ABI 问题 → arm64-v8a 为主流；模拟器注意 x86_64 套件
 ├─ Qt5 代码迁移 → QAndroidJniObject→QJniObject、
 │   QtAndroid::→QtAndroidPrivate/QNativeInterface、
 │   androidextras 模块已并入 QtCore
 └─ wait for debugger 卡死 → 关掉"等待调试程序"再正常启动
```

## 8. 小结

```
 本文要点回顾
 ├─ 结构：一个 QtActivity 承载 Qt 全部绘制与事件
 ├─ 环境：JDK 17 + 配套 SDK/NDK（版本表对齐 6.8 官方）
 ├─ 构建：androiddeployqt 打包 → Gradle → APK；
 │   release 必须签名（keytool + jarsigner）
 ├─ 调试：adb logcat 看 qDebug；LLDB + SIGSTOP 技巧
 ├─ 工程：android/ 目录纳管（QT_ANDROID_PACKAGE_SOURCE_DIR）；
 │   权限要"Manifest 声明 + 运行时申请"双管齐下
 └─ 互调：QJniObject = 全限定类名 + JNI 签名
```

**进阶指引**

- 自定义 Activity 完整流程、JNI 动态注册与 `JNI_OnLoad` 时机、Activity 结果回传——见 **P3-06** Android 实战。

**思考题**

1. 为什么 Qt Android 应用只有一个主 Activity？这个结构和 QML 的"单窗口模型"（P1-09）有什么相通之处？
2. 权限在 Manifest 里声明了，运行时申请却不弹对话框，可能的原因有哪些？
3. JNI 签名 `(Ljava/lang/String;I)[Ljava/lang/String;` 描述的函数原型是什么？（参数、返回值各是什么类型）
