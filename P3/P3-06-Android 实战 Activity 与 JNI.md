# P3-06 Android 实战：自定义 Activity 与 JNI

> 本文基于 **Qt 6.8.3**。定位：P1-15 的实战深挖篇——自定义 Activity 全流程、
> C++ 与 Java 双向互调（QJniObject / RegisterNatives / JNI_OnLoad）、Service
> 与跨进程、以及 Java 与 Qt 交互方式的选型总结。文中 Qt 5 写法均已随文标注
> Qt 6 对应关系（QAndroidJniObject→QJniObject 等）。

## 1. 自定义 Activity 全流程

跳转到一个新的 Java Android 页面操作。为什么自定义 Activity 必须用 Java 写？因为 Activity 是 Android 框架创建的组件，Qt-C++ 没有创建 Activity 的支持——你只能写 Java 类 + Manifest 声明，再从 C++ 侧 startActivity。

```cpp
void App::showScondActivity()
{
    QAndroidIntent intent(QtAndroid::androidActivity().object(), "src/orm/ScondActivity");
    QtAndroid::startActivity(intent, 0);
}

```

ScondActivity.java

```java
package src.orm;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.os.Bundle;

public class ScondActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(org.qtproject.example.JieTestAndroid.R.layout.scond_activity);
    }
}
```

scond_activity.xml

```xml
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/relativeLayout"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:padding="20dp">

    <TextView
        android:id="@+id/blackboard_text"
        android:layout_width="match_parent"
        android:layout_height="350dp"
        android:layout_gravity="center"
        android:gravity="center"
        android:singleLine="false"
        android:text="hello word!"
        android:textAlignment="center"
        android:textSize="60sp" />
</LinearLayout>
```

AndroidManifest.xml 清单文件增加

```xml
<activity android:name="src.orm.ScondActivity" android:exported="false" android:label="JieTestAndroid" android:screenOrientation="unspecified"/>
```

但是在 Qt 里面写 Android 代码是没有提示的，这点是非常难受的，可能说 Qt for Android 也不推荐你在里面写过多的 Java-Android 代码。

### CustomActivity（自定义 Activity）

[CustomActivity（官方例子）](https://code.qt.io/cgit/qt/qtandroidextras.git/tree/examples/androidextras/customactivity?h=5.15)

如果你要自定义一个新的 Activity，则是需要编写 Android-Java 代码来进行生成。你是无法用 Qt-Cpp 代码重新生成一个自定义的 Activity 的，没有这方面的支持的。

先看官方提供的一个示例项目文件结构：

```
 CustomActivity 项目
 ├─ customactivity.pro        项目配置
 ├─ activityhandler.h/.cpp    C++ 侧：发起跳转、接收结果
 ├─ main.cpp / main.qml       Qt 界面（主 Activity 绘制）
 └─ android/                  Android 侧（目录名固定）
     ├─ res/layout/second_activity.xml   Java 页布局
     ├─ res/values/strings.xml           字符串常量
     ├─ src/.../CustomActivity.java      自定义 Activity
     └─ AndroidManifest.xml              清单
```

+ customactivity.pro 这个是项目配置文件
+ c++ 文件

activityhandle.h；activityhandle.cpp；main.cpp 这些都是 cpp 文件。

+ qml 文件

main.qml 则是 qml 的 ui 代码文件。

+ android

在资源文件里面 android 这个命名是有意义的，它是表明这是 android 的相关文件了。res 文件夹里面的 layout/second_activity.xml 则是布局文件，values/strings.xml 则是字符串常量文件，src 文件夹一系列下面的 CustomActivity.java 这个是 Java 代码文件。

AndroidManifest.xml 则是 Android 程序的清单文件。

> 这些目录的格式和文件其实是按照 Android 开发来编写的，这是规则。
>
> 程序清单文件设置的包命名是非常重要的，因为它涉及到你创建 java 的目录关联的 Activity。
>

从上面的代码大致上分为两类，Qt 代码与 Android 代码。

Qt 代码比如 main.qml 这些代码则是由主要 Activity 进行绘制的，相关的代码关联也仅限于 Qt。

Android 的代码则是由 java 进行加上 Android 框架机制进行运行，规则也是 Android 框架的。

看一下 CustomActivity.java 代码是如何生成一个新的 Activity：

```java
package org.qtproject.example.activityhandler;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;

 public class CustomActivity extends Activity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.second_activity);

        Button backButton = (Button) findViewById(R.id.backButton);
        backButton.setOnClickListener(new View.OnClickListener() {

            @Override
            public void onClick(View view) {
                Intent resultIntent = new Intent();
                resultIntent.putExtra("message", "Back button clicked.");
                setResult(Activity.RESULT_OK, resultIntent);
                finish();
            }
        });
    }
}

```

R.layout.second_activity 这个是 R 类是由 Android 的 aapt 工具生成的类，这里面的逻辑就跟 Android 开发是一样的。

finish() 函数则是结束退出当前 Activity，在结束之前设置返回值的 Intent。

> 为什么是 Intent？因为 Android 里面 Activity 的通信，则是依靠 Intent 来进行传递的。
>

second_activity.xml 布局文件，xml 描述的布局 UI：

```xml
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/relativeLayout"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:padding="20dp">

    <TextView
        android:id="@+id/blackboard_text"
        android:layout_width="match_parent"
        android:layout_height="350dp"
        android:layout_gravity="center"
        android:gravity="center"
        android:singleLine="false"
        android:text="@string/hello_second_activity"
        android:textAlignment="center"
        android:textSize="60sp" />

    <Button
        android:id="@+id/backButton"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="@string/go_back"
        android:layout_gravity="center_vertical|center_horizontal" />
</LinearLayout>
```

main.cpp（开始函数）

```cpp
#include "activityhandler.h"

#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>

int main(int argc, char *argv[])
{
    QGuiApplication::setAttribute(Qt::AA_EnableHighDpiScaling);
    QGuiApplication app(argc, argv);
    QQmlApplicationEngine engine;
    const QUrl url(QStringLiteral("qrc:/main.qml"));

    ActivityHandler *activityHandler = new ActivityHandler(&app);
    engine.rootContext()->setContextProperty(QLatin1String("activityHandler"), activityHandler);

    QObject::connect(&engine, &QQmlApplicationEngine::objectCreated,
                     &app, [url](QObject *obj, const QUrl &objUrl) {
        if (!obj && url == objUrl)
            QCoreApplication::exit(-1);
    }, Qt::QueuedConnection);
    engine.load(url);

    return app.exec();
}
```

这里的代码就比较熟悉了，创建了 QML 引擎以及注册一个单例对象到里面使用。

activityhandle.h

```cpp
#ifndef MULTIACTIVITY_H
#define MULTIACTIVITY_H

#include <QtAndroid>

class ActivityHandler : public QObject
{
    Q_OBJECT

public:
    ActivityHandler(QObject *parent = nullptr);
    static ActivityHandler *instance() { return m_instance; }

    Q_INVOKABLE void showSecondActivity();
    void activityReceiver(int requestCode, int resultCode, const QAndroidJniObject &data);

signals:
    void receiveFromActivityResult(const QString &message);

private:
    static ActivityHandler *m_instance;
};

#endif // MULTIACTIVITY_H
```

activityhandle.cpp

```cpp
#include "activityhandler.h"

#include <QAndroidIntent>

const int REQUEST_CODE = 123;
const jint RESULT_OK = QAndroidJniObject::getStaticField<jint>("android/app/Activity", "RESULT_OK");
ActivityHandler *ActivityHandler::m_instance = nullptr;

ActivityHandler::ActivityHandler(QObject *parent) : QObject(parent)
{
    m_instance = this;
}

void ActivityHandler::showSecondActivity()
{
    // QtAndroid::androidActivity().object()获取主Activity，以及新的Activity
    QAndroidIntent activityIntent(QtAndroid::androidActivity().object(),
                                  "org/qtproject/example/activityhandler/CustomActivity");

    QtAndroid::startActivity(
            activityIntent.handle(), REQUEST_CODE,
            [this](int requestCode, int resultCode, const QAndroidJniObject &data) {
                activityReceiver(requestCode, resultCode, data);
            });
}

void ActivityHandler::activityReceiver(int requestCode, int resultCode, const QAndroidJniObject &data)
{
    if (requestCode == REQUEST_CODE) {
        if (resultCode == RESULT_OK) {
            const QAndroidJniObject key = QAndroidJniObject::fromString("message");
            const QAndroidJniObject message = data.callObjectMethod(
                    "getStringExtra", "(Ljava/lang/String;)Ljava/lang/String;", key.object());
            if (message.isValid())
                emit ActivityHandler::instance()->receiveFromActivityResult(message.toString());
        } else {
            emit ActivityHandler::instance()->receiveFromActivityResult("Rejected!");
        }
    }
}
```

> 以上 CustomActivity 示例代码是 Qt 5 写法：`QAndroidJniObject` 在 Qt 6.2 起改名为 `QJniObject`，`QtAndroid::androidActivity()` 在 Qt 6 中对应 `QNativeInterface::QAndroidApplication::context()`，`QtAndroid::startActivity()` 对应 `QtAndroidPrivate::startActivity()`。其余逻辑（Intent、startActivityForResult、R 类）在 Qt 6 中完全一致。


## 2. JNIMessenger：C++ 与 Java 双向通信


[jnimessenger（官方示例）](https://code.qt.io/cgit/qt/qtandroidextras.git/tree/examples/androidextras/jnimessenger?h=5.15)

其实笔者发现所有的解释性语言通信的基础都是 C 语言，因为这些解释性语言的调用解释之后都是为 C 语言进行描述。

比如这个签名：

```cpp
static void callFromJava(JNIEnv *env, jobject /*thiz*/, jstring value)
{
    emit JniMessenger::instance()->messageFromJava(env->GetStringUTFChars(value, nullptr));
}
```

前两个参数是固定的，一个是 java 环境解释器，一个是 java 对象，最后一个则是值（参数1）。

Java 这边也不例外，它提供一个原生 API 支持（官方叫法）。

```java
package org.qtproject.example.jnimessenger;

public class JniMessenger
{
    // 声明一个函数，该函数由外部进行实现。注册到java运行环境中去
    private static native void callFromJava(String message);

    public JniMessenger() {}

    public static void printFromJava(String message)
    {
        System.out.println("This is printed from JAVA, message is: " + message);
        callFromJava("Hello from JAVA!");
    }
}
```

callFromJava() 这个函数，是由外部原生实现，它是直接注册到 Java 环境里面去的一个函数。这里就提供了一个 Java 调用到 C++ 方式的途径。

在调用之前，你需要将这个类型注册到环境中去。

```cpp
JniMessenger::JniMessenger(QObject *parent) : QObject(parent)
{
    m_instance = this;

    JNINativeMethod methods[] {{"callFromJava", "(Ljava/lang/String;)V", reinterpret_cast<void *>(callFromJava)}};
    QAndroidJniObject javaClass("org/qtproject/example/jnimessenger/JniMessenger");

    QAndroidJniEnvironment env;
    // 创建对象
    jclass objectClass = env->GetObjectClass(javaClass.object<jobject>());
    // 注册到java运行的环境中去
    env->RegisterNatives(objectClass,
                         methods,
                         sizeof(methods) / sizeof(methods[0]));
    // 释放对象
    env->DeleteLocalRef(objectClass);
}
```

这个注册是必须的，否则 Java 调用时就会出问题。但为什么，需要创建对象以及删除对象呢？这个原因很简单，注册需要一个实际对象，注册完之后这个对象用不到了就删除了。

Cpp 调用 Java 则是使用了 Qt 的 Android 支持对象：

```cpp
void JniMessenger::printFromJava(const QString &message)
{
    QAndroidJniObject javaMessage = QAndroidJniObject::fromString(message);
    QAndroidJniObject::callStaticMethod<void>("org/qtproject/example/jnimessenger/JniMessenger",
                                       "printFromJava",
                                       "(Ljava/lang/String;)V",
                                        javaMessage.object<jstring>());
}
```

具体原代码，移步查看官方示例，笔者这里就不贴出来了。

## 3. JNI 签名类型表与调用示例

QJniObject（Qt 5 为 QAndroidJniObject）提供了 C++ 调用 Java 的方法支持，但它并非直接调用，而是通过 JNI 来提供支持。所以调用时要按 JNI 的方式来：

+ 类名需要完全限定，例如 `java/lang/String`
+ 方法签名写成 `(Arguments)ReturnType`
+ 所有对象类型都作为 QJniObject 返回

签名结构是 `(A)R`：A 是参数类型，R 是返回类型。数组类型带 `[` 前缀，完全限定类型带 `L` 前缀和 `;` 后缀。

+ 对象类型

| 类型 | 签名 |
| --- | --- |
| jobject | Ljava/lang/Object; |
| jclass | Ljava/lang/Class; |
| jstring | Ljava/lang/String; |
| jthrowable | Ljava/lang/Throwable; |
| jobjectArray | [Ljava/lang/Object; |
| jarray | [_&lt;type&gt;_ |
| jbooleanArray | [Z |
| jbyteArray | [B |
| jcharArray | [C |
| jshortArray | [S |
| jintArray | [I |
| jlongArray | [J |
| jfloatArray | [F |
| jdoubleArray | [D |

+ 主要类型

| 类型 | 签名 |
| --- | --- |
| jboolean | Z |
| jbyte | B |
| jchar | C |
| jshort | S |
| jint | I |
| jlong | J |
| jfloat | F |
| jdouble | D |

+ 其它类型

| 类型 | 签名 |
| --- | --- |
| void | V |
| _Custom type（自定义类型）_ | L_&lt;fully-qualified-name&gt;_; |

### 调用示例

java 对象

```java
// Java class
 package org.qtproject.qt5;
 class TestClass
 {
    static String fromNumber(int x) { // ... }
    static String[] stringArray(String s1, String s2) { // ... }
 }
```

第一个函数的签名是"(I)Ljava/lang/String;"

```cpp
// C++ code
 QAndroidJniObject stringNumber = QAndroidJniObject::callStaticObjectMethod("org/qtproject/qt5/TestClass",
                                                                            "fromNumber"
                                                                            "(I)Ljava/lang/String;",
                                                                            10);

```

第二个函数的签名是"(Ljava/lang/String;Ljava/lang/String;)[Ljava/lang/String;"

```cpp
// C++ code
 QAndroidJniObject string1 = QAndroidJniObject::fromString("String1");
 QAndroidJniObject string2 = QAndroidJniObject::fromString("String2");
 QAndroidJniObject stringArray = QAndroidJniObject::callStaticObjectMethod("org/qtproject/qt5/TestClass",
                                                                           "stringArray"
                                                                           "(Ljava/lang/String;Ljava/lang/String;)[Ljava/lang/String;"
                                                                            string1.object<jstring>(),
                                                                            string2.object<jstring>());
```

ps：[Ljava/lang/String; 表示数组。

### 异常处理

当调用可能抛出异常的 Java 函数时，在继续之前检查、处理和清除异常是很重要的。

> 注意：当有异常挂起时进行 JNI 调用是不安全的。
>

```cpp
 void functionException()
 {
     QAndroidJniObject myString = QAndroidJniObject::fromString("Hello");
     jchar c = myString.callMethod<jchar>("charAt", "(I)C", 1000);
     QAndroidJniEnvironment env;
     if (env->ExceptionCheck()) {
         // Handle exception here.
         env->ExceptionClear();
     }
 } 
```


## 4. Java 回调 C++：动态注册与 JNI_OnLoad

### Java 调用原生 C 方法（动态注册）

Java 本机方法使得从 Java 调用本机代码成为可能，这是通过在 Java 中创建函数声明并使用 native 关键字作为前缀来实现的。在可以从 Java 调用本机函数之前，需要将 Java 本机函数映射到代码中的本机函数。映射函数可以通过 JNI 环境指针调用 RegisterNatives() 函数来完成。

```java
class FooJavaClass
 {
     public static void foo(int x)
     {
         if (x < 100)
             callNativeOne(x);
         else
             callNativeTwo(x);
     }

     // 原生C方法
 private static native void callNativeOne(int x);
 private static native void callNativeTwo(int x);

 }
```

c++ 实现

```cpp
 static void fromJavaOne(JNIEnv *env, jobject thiz, jint x)
 {
     Q_UNUSED(env)
     Q_UNUSED(thiz)
     qDebug() << x << "< 100";
 }

 static void fromJavaTwo(JNIEnv *env, jobject thiz, jint x)
 {
     Q_UNUSED(env)
     Q_UNUSED(thiz)
     qDebug() << x << ">= 100";
 }

 void registerNativeMethods() {
     JNINativeMethod methods[] {{"callNativeOne", "(I)V", reinterpret_cast<void *>(fromJavaOne)},
                                {"callNativeTwo", "(I)V", reinterpret_cast<void *>(fromJavaTwo)}};

     QAndroidJniObject javaClass("my/java/project/FooJavaClass");
     QAndroidJniEnvironment env;
     jclass objectClass = env->GetObjectClass(javaClass.object<jobject>());
     env->RegisterNatives(objectClass,
                          methods,
                          sizeof(methods) / sizeof(methods[0]));
     env->DeleteLocalRef(objectClass);
 }

 void foo()
 {
     QAndroidJniObject::callStaticMethod<void>("my/java/project/FooJavaClass", "foo", "(I)V", 10);  // Output: 10 < 100
     QAndroidJniObject::callStaticMethod<void>("my/java/project/FooJavaClass", "foo", "(I)V", 100); // Output: 100 >= 100
 } 
```

通过注册这些方法到 java env 环境中去，得以支持从 java 对象调用这些 C 的注册环境方法。

可以查看 QAndroidJniObject 构造函数，了解更多构造 java 对象的方式。

### JNI 注册时机

JNI 的注册时机有两个关键点：

1. **静态注册**（通过函数名自动查找）：在 Java 类首次使用 native 方法时，JVM 会尝试查找对应的 C 函数
2. **动态注册**（通过 RegisterNatives）：**必须在 Java 类加载之后、native 方法第一次调用之前**完成注册

### 最佳注册时机（JNI_OnLoad 中，直接进行注册）

```cpp
// main.cpp
#ifdef Q_OS_ANDROID
#include <QJniEnvironment>

// 1. 定义 JNI 回调函数
static void onProgress(JNIEnv *env, jobject thiz, jint progress) {
    qDebug() << "进度:" << progress;
    // 使用队列连接确保线程安全
    QMetaObject::invokeMethod(qApp, [progress]() {
        UploadHelper::instance()->updateProgress(progress);
    }, Qt::QueuedConnection);
}

static void onComplete(JNIEnv *env, jobject thiz) {
    QMetaObject::invokeMethod(qApp, []() {
        UploadHelper::instance()->uploadFinished();
    }, Qt::QueuedConnection);
}

// 2. 在 JNI_OnLoad 中注册（最佳时机）
JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void* reserved) {
    QJniEnvironment env;
    
    // 查找 Java 类
    jclass clazz = env.findClass("com/yourpackage/QtAndroidService");
    if (!clazz) {
        qWarning() << "找不到 Java 类";
        return JNI_ERR;
    }
    
    // 注册 native 方法
    JNINativeMethod methods[] = {
        {"onProgressUpdate", "(I)V", (void*)&onProgress},
        {"onUploadComplete", "()V", (void*)&onComplete}
    };
    
    if (env->RegisterNatives(clazz, methods, 2) < 0) {
        qWarning() << "注册 native 方法失败";
        return JNI_ERR;
    }
    
    qDebug() << "JNI 方法注册成功";
    return JNI_VERSION_1_6;
}
#endif
```

执行时序图（可以看到，JNI_OnLoad 注册的时机是非常早的）：

```plain
时间轴     JNI_OnLoad                 Java类加载                 native方法调用
  ↓
 0ms  [SO库加载] 
  ↓      ↓
10ms  [JNI_OnLoad 执行] 
  ↓      ├─ 查找 Java 类 (此时类可能还未完全初始化)
  ↓      ├─ 注册 native 方法 ✅ 关键注册点
  ↓      └─ 返回 JNI_VERSION
  ↓
20ms  [Java 虚拟机继续初始化]
  ↓      ↓
30ms  [Java 类 QtAndroidService 加载]
  ↓      ├─ 静态代码块执行
  ↓      ├─ 字段初始化
  ↓      └─ 类准备就绪
  ↓
40ms  [服务创建]
  ↓      ↓
50ms  [onCreate() 调用]
  ↓      ↓
60ms  [reportProgress() 调用]
  ↓      ↓
70ms  [native 方法调用] 
  ↓      └─ ✅ JVM 找到已注册的 C 函数
  ↓
80ms  [C++ onProgress 执行]
```

### 在 Qt 应用初始化时注册（稍慢）

```cpp
// main.cpp
int main(int argc, char *argv[])
{
    QCoreApplication app(argc, argv);
    
    // 尽早注册 JNI 方法
    registerJniMethods();  // 自定义函数
    
    // 继续其他初始化
    UploadService service;
    
    return app.exec();
}

void registerJniMethods() {
    QJniEnvironment env;
    jclass clazz = env.findClass("com/yourpackage/QtAndroidService");
    
    if (clazz) {
        Q_DECLARE_JNI_NATIVE_METHOD_IN_CURRENT_SCOPE(onProgress, "(I)V", onProgress)
        Q_DECLARE_JNI_NATIVE_METHOD_IN_CURRENT_SCOPE(onComplete, "()V", onComplete)
        
        JNINativeMethod methods[] = {
            onProgress_jni_method,
            onComplete_jni_method
        };
        
        env->RegisterNatives(clazz, methods, 2);
    }
}
```

比 JNI_OnLoad 晚一些，但通常在 Java 调用之前。

## 5. Service 与四大组件

除了 Broadcast Receiver 可以在代码中动态注册，**其他三个组件（Activity、Service、Content Provider）都必须在 `AndroidManifest.xml` 文件中声明**，否则系统无法识别它们。这也是你之前添加 Service 声明时做的操作。

+ Activity 管界面显示;
+ Service 管后台干活;
+ Broadcast Receiver 管接收系统广播;
+ Content Provider 管数据共享;

其中 Service，经常性配置为独立进程进行后台服务运行。

| 组件 | 能否独立进程 | 默认行为 | 常见用法 |
| --- | --- | --- | --- |
| **Activity** | ✅ 可以 | **主进程** | 通常不独立，因为需要显示界面 |
| **Service** | ✅ 可以 | **主进程** | **经常配置为独立进程**（如后台下载） |
| **Broadcast Receiver** | ✅ 可以 | **主进程** | 通常不独立，生命周期极短 |
| **Content Provider** | ✅ 可以 | **主进程** | 通常不独立，但可以提供跨进程数据访问 |

图形展示它们之间的关系：

```plain
┌─────────────────────────────────────┐
│     进程A：主进程（UI进程）           │
│  ┌─────────────────────────────┐   │
│  │ Activity                    │   │
│  │ Broadcast Receiver          │   │ ← 这些组件通常在主进程
│  │ Content Provider            │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
                  ↑ 跨进程通信
                  ↓
┌─────────────────────────────────────┐
│     进程B：Service进程               │
│  ┌─────────────────────────────┐   │
│  │ Service                     │   │ ← 独立进程，后台运行
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

稍微有些争议点就是，如果你使用 startActivity()，打开一个新的 Activity，如果是自己程序的，那么还是在主进程里面。如果是别的程序，那么肯定就是另一个进程。

但是在 Qt for Android 里面，如果 Service 不是独立进程，它处于主进程中。那么只能存在一个 Service，这个是 Qt Bug 目前没有办法解决。

_**通常 Qt 开发设计**_

一般来说，在 Qt for Android 开发中不会写太多的 Java 代码，如果程序切换至后台，通常 Activity 是会被受限以至于无法进行正常的网络通信等操作服务。

一般常规做法是，创建一个 service 在主进程使用，同时将这个 service 设置为前台服务，这样就能够进行长期的后台服务操作，前台服务不会被系统限制。

至于独立进行的 service 虽然不会被系统杀死，但它在另一个进程，通信只能采用 IPC 之类的手段，相对于 qt c++ 开发者来说这是很不舒服的。

service 同进程下，main 函数并不会被调用第二次。

```plain
┌─────────────────────────────────────────────────────────────┐
│                   同一个进程 (PID: 1234)                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [main() 函数代码区] ← 进程启动时加载，只执行一次               │
│                                                             │
│  [主线程]                                                   │
│  ├─ main() 执行 → QGuiApplication app(argc, argv)          │
│  ├─ app.exec() 事件循环开始                                 │
│  └─ (永远阻塞在这里，处理 UI 事件)                            │
│                                                             │
│  [Qt 主事件循环]                                             │
│  ├─ 处理 UI 更新                                            │
│  ├─ 处理定时器                                              │
│  └─ 处理服务回调（通过 JNI）                                  │
│                                                             │
│  [Java 世界]                                                │
│  ├─ QtActivity                                              │
│  └─ QtAndroidService (同进程)                               │
│      └─ JNI 调用直接进入已存在的 C++ 世界                     │
└─────────────────────────────────────────────────────────────┘
```

这是启动同进程的相关逻辑

```java
// 1. 启动服务（同进程）
context.startService(new Intent(context, QtAndroidService.class));

// 2. QtAndroidService.onCreate() 被调用
public class QtAndroidService extends QtService {
    @Override
    public void onCreate() {
        super.onCreate();  // ← 这里不会创建新进程，不会调用新 main()
        
        // 3. super.onCreate() 内部：
        //    - 加载 Qt 库（如果已加载则跳过）
        //    - 找到已存在的 qtMainLoopThread
        //    - **不会**创建新线程执行 main()
        //    - 直接返回，使用已有的事件循环
        
        startForeground(NOTIFICATION_ID, createNotification());
    }
}
```

但如果是 Service 是独立进程，那么 main 就会再次被调用，因为它是启动了另一个进程，调用的是另一个进程的 main。

同进程的 service，是针对程序只会进入后台，不会被手动划掉杀死的情况。


## 6. 启动流程与跨进程

### 主应用进程启动流程（Activity → Qt）

```plain
[用户点击应用图标] 
       ↓
[Android系统]
       ↓
[Launcher启动Activity] 
       ↓
[Android Framework]
       ↓
┌─────────────────────────────────────────────────────┐
│                 Java 世界 (主进程)                    │
├─────────────────────────────────────────────────────┤
│  QtActivity.onCreate()                               │
│    ↓                                                 │
│  super.onCreate()  [QtActivity.java]                 │
│    ↓                                                 │
│  ┌─────────────────────────────────────────────────┐ │
│  │ QtLoader.startMainThread()  [Qt内部]             │ │
│  │   ├─ 设置环境变量                                 │ │
│  │   ├─ 加载Qt库 (libQt6Core.so, libYourApp.so)     │ │
│  │   └─ 创建 qtMainLoopThread 线程                  │ │
│  └─────────────────────────────────────────────────┘ │
│    ↓                                                 │
│  [qtMainLoopThread 线程启动]                          │
└─────────────────────────────────────────────────────┘
       ↓                          ↓
       ↓ (等待)                   ↓ (新线程执行)
       ↓                          ↓
┌─────────────────────────────────────────────────────┐
│  Java世界继续执行          │    C++世界 (主进程)        │
│  QtActivity.onCreate()     │  ├──────────────────────┤
│  返回后执行其他初始化        │  │ main() 函数执行       │
│                            │  │   ↓                   │
│  (UI线程继续运行)           │  │ QGuiApplication创建   │
│                            │  │   ↓                   │
│                            │  │ QQmlApplicationEngine │
│                            │  │   ↓                   │
│                            │  │ 加载QML并显示UI        │
│                            │  │   ↓                   │
│                            │  │ app.exec() 事件循环   │
│                            │  │ (阻塞，处理Qt事件)      │
│                            │  └──────────────────────┘
└─────────────────────────────────────────────────────┘
```

QtActivity 是 qt 编译器自动生成的一个 Activity 对象，它在 onCreate() 函数，创建了一个运行 Qt 世界所需要的线程，并执行了 main() 函数，至此进入到 Qt 的世界，也就是直接运行的二进制代码。

在 Qt 世界成功运行之后，开辟线程的阻塞函数会返回 QtActivity.onCreate() 函数接着往下执行，这个时候就可以调用 qt c++ 的方法了。

### 服务进程启动流程（Service → Qt）

```plain
[从主应用调用 startService() 或 startForegroundService()]
       ↓
[Android系统]
       ↓
[创建新进程 (如果配置了android:process)]
       ↓
┌─────────────────────────────────────────────────────┐
│                 Java 世界 (服务进程)                   │
├─────────────────────────────────────────────────────┤
│  QtAndroidService.onCreate()                         │
│    ↓                                                 │
│  super.onCreate()  [QtService.java]                  │
│    ↓                                                 │
│  ┌─────────────────────────────────────────────────┐ │
│  │ QtLoader.startMainThread()  [Qt内部]             │ │
│  │   ├─ 设置环境变量                                 │ │
│  │   ├─ 加载Qt库 (再次加载，独立进程)                 │ │
│  │   └─ 创建 qtMainLoopThread 线程                  │ │
│  └─────────────────────────────────────────────────┘ │
│    ↓                                                 │
│  [qtMainLoopThread 线程启动]                          │
└─────────────────────────────────────────────────────┘
       ↓                          ↓
       ↓ (等待)                   ↓ (新线程执行)
       ↓                          ↓
┌─────────────────────────────────────────────────────┐
│  Java世界继续执行          │    C++世界 (服务进程)      │
│  QtAndroidService.onCreate()│  ├──────────────────────┤
│  返回后执行:                │  │ main() 函数执行       │
│    ↓                        │  │   ↓                   │
│  createNotificationChannel()│  │ 检查命令行参数        │
│    ↓                        │  │   ↓                   │
│  createNotification()       │  │ 检测到 "-service"     │
│    ↓                        │  │   ↓                   │
│  startForeground()          │  │ QCoreApplication创建 │
│    ↓                        │  │   ↓                   │
│  (至此，前台服务已建立)       │  │ UploadService对象创建 │
│                            │  │   ↓                   │
│  (等待后续JNI调用)           │  │ app.exec() 事件循环   │
│                            │  │ (阻塞，处理上传任务)    │
│                            │  └──────────────────────┘
└─────────────────────────────────────────────────────┘
```

### 时序对比图（主进程 vs 服务进程）

```plain
时间轴  主进程 (Activity)           服务进程 (Service)
  ↓     ↓                           ↓
 0ms   用户点击应用图标
  ↓     ↓
 10ms  QtActivity.onCreate()
  ↓     ↓
 20ms  ├─ super.onCreate()          (服务进程尚未创建)
  ↓     ↓   ↓
 30ms  │   └─ 创建qtMainLoopThread
  ↓     ↓   ↓
 40ms  │      └─ 执行C++ main()     (服务进程仍不存在)
  ↓     ↓                           ↓
 50ms  │          ↓                 (用户调用startService)
  ↓     ↓                           ↓
 60ms  │          ↓                 Android创建新进程
  ↓     ↓                           ↓
 70ms  │          ↓                 QtAndroidService.onCreate()
  ↓     ↓                           ↓
 80ms  │          ↓                 ├─ super.onCreate()
  ↓     ↓                           ↓   ↓
 90ms  │          ↓                 │   └─ 创建qtMainLoopThread
  ↓     ↓                           ↓   ↓
100ms  │          ↓                 │      └─ 执行C++ main()
  ↓     ↓                           ↓          ↓
110ms  │          ↓                 │         检查参数
  ↓     ↓                           ↓          ↓
120ms  │          ↓                 │         创建QCoreApplication
  ↓     ↓                           ↓          ↓
130ms  │          ↓                 │         UploadService初始化
  ↓     ↓                           ↓          ↓
140ms  │          ↓                 │         app.exec() 事件循环开始
  ↓     ↓                           ↓          ↓
150ms  │          ↓                 └─ onCreate()返回
  ↓     ↓                           ↓
160ms  │          ↓                 └─ startForeground()调用
  ↓     ↓                           ↓
170ms  │          ↓                 服务前台化完成，开始上传
  ↓     ↓                           ↓
180ms  │          ↓                 │ 定时器触发
  ↓     ↓                           ↓   ↓
190ms  │          ↓                 │ JNI回调通知Java层进度
  ↓     ↓                           ↓
...    ...                         ...
```

### 跨进程通信流程（QtRO 方式）

```plain
┌─────────────────┐                    ┌─────────────────┐
│  主应用进程       │                    │  服务进程        │
│  (UI进程)        │                    │  (上传进程)      │
├─────────────────┤                    ├─────────────────┤
│  C++ Qt世界      │                    │  C++ Qt世界      │
├─────────────────┤                    ├─────────────────┤
│  QRemoteObjectNode│                    │  QRemoteObjectHost│
│  connectToNode() │───(建立连接)───────▶│  enableRemoting()│
│                  │                    │                  │
│  acquireReplica()│◄───(返回代理对象)───│  Service对象     │
│                  │                    │                  │
│  replica->upload()│───(IPC调用)───────▶│  upload()实现    │
│                  │                    │  {              │
│                  │                    │    // 上传逻辑    │
│                  │                    │    emit progress│
│                  │                    │  }              │
│                  │◄───(信号传递)───────│                  │
│  onProgress()    │                    │                  │
└─────────────────┘                    └─────────────────┘
        ↑                                       ↑
        │ JNI调用                               │ JNI调用
        ↓                                       ↓
┌─────────────────┐                    ┌─────────────────┐
│  Java世界       │                    │  Java世界        │
│  QtActivity     │                    │  QtAndroidService│
└─────────────────┘                    └─────────────────┘
```

### 生命周期对应关系

```plain
Android生命周期              Qt生命周期
─────────────────────────────────────────────
Service.onCreate()        →  main() 开始执行
                          →  QCoreApplication构造
                          →  QObject构造

Service.onStartCommand()  →  可以触发C++槽函数
                          →  QTimer启动等

Service.onDestroy()       →  QCoreApplication析构
                          →  main() 返回
                          →  进程结束

─────────────────────────────────────────────
Activity.onCreate()       →  main() 开始执行
                          →  QGuiApplication构造
                          →  QQmlEngine加载

Activity.onPause()        →  QGuiApplication状态改变
                          →  applicationStateChanged信号

Activity.onResume()       →  applicationStateChanged信号
                          →  应用回到前台
```

### 关键代码对应关系

```plain
// Java 层 (QtService.java)          // C++ 层 (main.cpp)
────────────────────────────────────────────────────────
super.onCreate() {                    int main() {
    // 加载Qt库                          // 创建应用对象
    loadQtLibraries();                  QCoreApplication app;
    
    // 创建线程执行main()                 // 初始化服务
    createThread(&main);   ──────────▶  UploadService service;
    
    // 等待线程启动                       // 进入事件循环
    waitForThread();                     return app.exec();
}                                     }
```

### 数据流向图

```plain
用户操作 → [Android系统] → [Java Activity/Service]
                                   ↓
                              [JNI 桥接层]
                                   ↓
                              [C++ main()]
                                   ↓
                         [QCoreApplication事件循环]
                                   ↓
                    ┌──────────────┴──────────────┐
                    ↓                              ↓
              [UploadService对象]            [QRemoteObjectHost]
                    ↓                              ↓
              [QTimer定时上传]                [IPC通信服务]
                    ↓                              ↓
              [网络请求处理]                    [跨进程信号]
                    ↓                              ↓
              [进度更新信号] ──────────────→ [主应用进度显示]
```


## 7. Java 与 Qt 交互方式总结

# Java 与 Qt 交互方式总结

五种交互方式的对比如下：

```plain
 方式                 耦合度   复杂度   适用场景          评级
 ──────────────────────────────────────────────────────────
 JNI 直接调用          高       低      简单单次调用       ⭐
 QJniObject 封装       中       中      C++ 主动调 Java    ⭐⭐
 信号槽桥接            低       中      Java 事件回调 Qt   ⭐⭐⭐
 广播 Broadcast       低       低      松耦合系统级通信    ⭐⭐
 AIDL                 低       高      跨进程标准 IPC     ⭐⭐
```

### JNI (Java Native Interface) 直接调用 ⭐ 最基础

+ 从 Java 调用 C++ (Native 方法)

```java
// Java 端
public class QtAndroidService extends QtService {
    // 声明native方法
    public native void onUploadProgress(int progress);
    public native String getUploadStatus();
    
    // 调用native方法
    private void reportProgress(int percent) {
        onUploadProgress(percent);  // 调用C++
    }
}
```

```cpp
// C++ 端
extern "C" {
    JNIEXPORT void JNICALL
    Java_com_yourpackage_QtAndroidService_onUploadProgress(JNIEnv *env, jobject thiz, jint progress) {
        // 将进度传递给Qt对象
        UploadManager::instance()->updateProgress(progress);
    }
    
    JNIEXPORT jstring JNICALL
    Java_com_yourpackage_QtAndroidService_getUploadStatus(JNIEnv *env, jobject thiz) {
        QString status = UploadManager::instance()->getStatus();
        return env->NewStringUTF(status.toUtf8().constData());
    }
}
```

更加推荐的方式

```cpp
// uploadhelper.h
class UploadHelper : public QObject
{
    Q_OBJECT
public:
    static UploadHelper* instance();
    
    // JNI 回调（静态方法，在 JNI 线程执行）
    static void onProgress(JNIEnv* env, jobject thiz, jint progress) {
        // 线程安全方式 1：直接 emit 信号（QueuedConnection）
        emit instance()->progressRequested(progress);
        
        // 线程安全方式 2：或者收集统计信息（原子操作）
        instance()->m_totalBytes += progress;
    }
    
    static void onComplete(JNIEnv* env, jobject thiz) {
        // 使用 invokeMethod 切换到主线程
        QMetaObject::invokeMethod(instance(), [instance = instance()]() {
            emit instance()->uploadFinished();
            instance()->saveUploadHistory();
        }, Qt::QueuedConnection);
    }
    
    // 注册 JNI 方法（在主线程调用）
    void registerJniMethods() {
        QJniEnvironment env;
        jclass clazz = env.findClass("com/yourpackage/QtAndroidService");
        
        Q_DECLARE_JNI_NATIVE_METHOD_IN_CURRENT_SCOPE(onProgress, "(I)V", onProgress)
        Q_DECLARE_JNI_NATIVE_METHOD_IN_CURRENT_SCOPE(onComplete, "()V", onComplete)
        
        JNINativeMethod methods[] = {
            onProgress_jni_method,
            onComplete_jni_method
        };
        
        env->RegisterNatives(clazz, methods, 2);
    }
    
signals:
    void progressRequested(int progress);  // 可以从任何线程 emit
    void uploadFinished();                  // 可以从任何线程 emit
    void progressChanged(int progress);     // 仅主线程 emit
    
private slots:
    void handleProgressRequest(int progress) {
        // 现在在主线程
        qDebug() << "上传进度:" << progress << "%";
        emit progressChanged(progress);  // 安全 emit
        
        // 更新 UI
        updateProgressBar(progress);
    }
    
private:
    UploadHelper() {
        // 关键：确保信号在主线程处理
        connect(this, &UploadHelper::progressRequested,
                this, &UploadHelper::handleProgressRequest,
                Qt::QueuedConnection);
        
        connect(this, &UploadHelper::uploadFinished,
                this, []() {
                    qDebug() << "上传完成在主线程处理";
                    // UI 更新
                }, Qt::QueuedConnection);
    }
    
    void updateProgressBar(int progress) {
        // UI 更新代码
    }
    
private:
    std::atomic<int> m_totalBytes{0};  // 原子操作，跨线程安全
};
```

> onProgress 是被 Java 调用的，它此时运行在 JNI 线程上，你最好跳转到 Qt 线程去执行相关操作。除此之外，这些注册 C 的方法，必须要在 Java 类加载之前注册。注册时机的详细讨论见「JNI 与 QJniObject」一章的「JNI 注册时机」一节。
>

这种方式已经被 Qt 内部进行包装，因此可以进行参考即可。

+ 从 C++ 调用 Java

```cpp
// C++ 端
#include <QJniObject>

void notifyJava() {
    // 调用静态方法
    QJniObject::callStaticMethod<void>(
        "com/yourpackage/QtAndroidService",
        "showNotification",
        "(Ljava/lang/String;)V",
        QJniObject::fromString("Upload complete").object<jstring>()
    );
    
    // 调用实例方法
    QJniObject service = QJniObject::callStaticMethod<jobject>(
        "com/yourpackage/QtAndroidService",
        "getInstance",
        "()Lcom/yourpackage/QtAndroidService;"
    );
    
    service.callMethod<void>("updateUI", "(I)V", 100);
    
    // 获取字段值
    jint value = service.getField<jint>("mCounter");
}
```

### Qt Android Extras (Qt 5) / QJniHelpers (Qt 6) ⭐⭐ 封装版 JNI

Qt 提供的封装类，简化 JNI 调用。

```cpp
// Qt 6 方式
#include <QJniObject>
#include <QJniEnvironment>

class AndroidHelper {
public:
    // 调用Java静态方法
    static void showToast(const QString& message) {
        QJniObject javaString = QJniObject::fromString(message);
        QJniObject::callStaticMethod<void>(
            "android/widget/Toast",
            "makeText",
            "(Landroid/content/Context;Ljava/lang/CharSequence;I)Landroid/widget/Toast;",
            QtAndroid::androidContext().object(),
            javaString.object(),
            jint(0)  // Toast.LENGTH_SHORT
        );
    }
    
    // 获取Java对象并操作
    static void startForegroundService() {
        QJniObject context = QtAndroid::androidContext();
        QJniObject intent("android/content/Intent");
        
        QJniObject className = QJniObject::fromString("com/yourpackage/QtAndroidService");
        intent.callObjectMethod("setClassName",
            "(Landroid/content/Context;Ljava/lang/String;)Landroid/content/Intent;",
            context.object(),
            className.object());
        
        context.callMethod<jobject>("startForegroundService",
            "(Landroid/content/Intent;)Landroid/content/ComponentName;",
            intent.object());
    }
    
    // 处理Java字符串
    static QString getDeviceName() {
        QJniObject manufacturer = QJniObject::getStaticObjectField(
            "android/os/Build", "MANUFACTURER", "Ljava/lang/String;");
        QJniObject model = QJniObject::getStaticObjectField(
            "android/os/Build", "MODEL", "Ljava/lang/String;");
        
        return manufacturer.toString() + " " + model.toString();
    }
};
```

### 信号槽桥接 (通过 JNI 实现) ⭐⭐⭐ 事件驱动

将 Java 的回调转换为 Qt 信号。

```cpp
// JavaCallbackBridge.h
class JavaCallbackBridge : public QObject
{
    Q_OBJECT
public:
    static JavaCallbackBridge* instance();
    
    // 供JNI调用的静态方法
    static void onJavaEvent(JNIEnv* env, jobject thiz, jstring event, jint value) {
        QString eventStr = QJniObject(event).toString();
        emit instance()->javaEvent(eventStr, value);
    }
    
signals:
    void javaEvent(QString event, int value);  // 转换为Qt信号
    
private:
    static JavaCallbackBridge* m_instance;
};
```

```java
// Java端调用
public class QtAndroidService extends QtService {
    private void notifyProgress(int progress) {
        // 调用C++静态方法，触发信号
        nativeOnProgress(progress);
    }
    
    private static native void nativeOnProgress(int progress);
}
```

```cpp
// 在Qt中使用
connect(JavaCallbackBridge::instance(), &JavaCallbackBridge::javaEvent,
        this, [](QString event, int value) {
    qDebug() << "Java事件:" << event << value;
    // 更新UI或处理业务逻辑
});
```

### Android Intents + BroadcastReceiver ⭐⭐ 广播通信

通过 Android 系统广播进行松耦合通信。

```java
// Java端发送广播
public class QtAndroidService extends QtService {
    private void sendProgressBroadcast(int progress) {
        Intent intent = new Intent("com.example.UPLOAD_PROGRESS");
        intent.putExtra("progress", progress);
        sendBroadcast(intent);
    }
}
```

```cpp
// C++端注册接收器
void setupBroadcastReceiver() {
    // 创建Java BroadcastReceiver
    const char* receiverClass = R"java(
        package com.yourpackage;
        
        public class ProgressReceiver extends BroadcastReceiver {
            public void onReceive(Context context, Intent intent) {
                int progress = intent.getIntExtra("progress", 0);
                onProgressReceived(progress);  // native方法
            }
            
            private static native void onProgressReceived(int progress);
        }
    )java";
    
    // 注册接收器
    QJniObject filter("android/content/IntentFilter");
    filter.callMethod<void>("addAction", "(Ljava/lang/String;)V",
        QJniObject::fromString("com.example.UPLOAD_PROGRESS").object());
    
    QtAndroid::androidContext().callMethod<void>("registerReceiver",
        "(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;)Landroid/content/Intent;",
        receiver.object(), filter.object());
}
```

### Android Services + AIDL ⭐⭐ 标准 Android IPC

使用 Android 的 AIDL 定义接口。

```java
// IUploadService.aidl
interface IUploadService {
    void startUpload(String filePath);
    void pauseUpload();
    int getProgress();
    void registerCallback(IUploadCallback callback);
}

// IUploadCallback.aidl
interface IUploadCallback {
    void onProgress(int percent);
    void onComplete();
}
```

```cpp
// C++端通过JNI调用AIDL接口
class AIDLHelper {
public:
    void callAIDLMethod() {
        QJniObject service = getAIDLService();
        jint progress = service.callMethod<jint>("getProgress");
    }
};
```

> 如果在 JNI 线程，记得要跳转到 Qt 世界的线程去，否则会出现跨线程访问问题。
>


## 8. 附：vcpkg 交叉依赖镜像

Android 交叉编译用 vcpkg 引入依赖时，下载同样受网络影响，可配置国内镜像：

# vcpkg 交叉依赖

```cmake
cmake_minimum_required(VERSION 3.16)
# 设置Android
set(VCPKG_TARGET_TRIPLET "arm64-android" CACHE STRING "")
# set(VCPKG_DOWNLOAD_MIRROR "https://mirrors.tuna.tsinghua.edu.cn/github-release/ninja-build/ninja/")
# set(X_VCPKG_ASSET_SOURCES "x-azurl,https://mirrors.tuna.tsinghua.edu.cn/vcpkg/assets/")

project(TestDemo VERSION 0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD_REQUIRED ON)


find_package(Qt6 REQUIRED COMPONENTS Quick)

qt_standard_project_setup(REQUIRES 6.8)

qt_add_executable(appTestDemo
    main.cpp
)

qt_add_qml_module(appTestDemo
    URI TestDemo
    QML_FILES
        Main.qml
)

# Qt for iOS sets MACOSX_BUNDLE_GUI_IDENTIFIER automatically since Qt 6.1.
# If you are developing for iOS or macOS you should consider setting an
# explicit, fixed bundle identifier manually though.
set_target_properties(appTestDemo PROPERTIES
#    MACOSX_BUNDLE_GUI_IDENTIFIER com.example.appTestDemo
    MACOSX_BUNDLE_BUNDLE_VERSION ${PROJECT_VERSION}
    MACOSX_BUNDLE_SHORT_VERSION_STRING ${PROJECT_VERSION_MAJOR}.${PROJECT_VERSION_MINOR}
    MACOSX_BUNDLE TRUE
    WIN32_EXECUTABLE TRUE
)

target_link_libraries(appTestDemo
    PRIVATE Qt6::Quick
)

include(GNUInstallDirs)
install(TARGETS appTestDemo
    BUNDLE DESTINATION .
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)

```

同时还需要添加两个环境变量

```shell
export VCPKG_DEFAULT_TRIPLET=arm64-android  # 或其他如 arm-android
export ANDROID_NDK_HOME=/path/to/your/android-ndk
```

这是设置工具链编译的路径，要具体到版本——系统环境变量示例：`ANDROID_NDK_HOME = C:\Users\jie\AppData\Local\Android\Sdk\ndk\27.2.12479018`。

这里是设置默认的编译目标三元组——系统环境变量：`VCPKG_DEFAULT_TRIPLET = arm64-android`。

## 9. 小结

```
 Android 深挖要点回顾
 ├─ 自定义 Activity：Java 编写 + Manifest 声明 +
 │   startActivity 跳转 + setResult/finish 回传
 ├─ C++ 调 Java：QJniObject = 全限定类名 + (A)R 签名；
 │   异常挂起时禁止继续 JNI 调用
 ├─ Java 调 C++：RegisterNatives 动态注册，
 │   最佳时机在 JNI_OnLoad（早于 Java 类首次调用）
 ├─ Service 有独立进程形态；跨进程可用 QtRO
 └─ 交互方式选型：JNI 直接调用（基础）→ QJniObject 封装
     → 信号槽桥接（事件驱动）→ Intent/广播 → AIDL
```

**进阶指引**

- 主线精简流程（环境/签名/调试/权限）——见 **P1-15**；JNI 回调里跨线程回主线程的元调用纪律——见 **P1-03**。
