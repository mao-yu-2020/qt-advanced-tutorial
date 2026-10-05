# P1-01 QObject 与元对象系统

> 本文基于 **Qt 6.8.3**。QObject 是 Qt 世界一切对象的根基，本篇讲清它提供的
> 能力以及背后的元对象系统。深入原理（moc/connect 源码实现）见 P2-01；
> 事件循环与线程亲和性的完整讲解见 P1-02。

## 1. QObject：Qt 世界的"基类公民"

Qt 里除了少量工具类（QString、QPoint 这类纯值类型），几乎所有类都继承自 QObject——无论是界面的还是非界面的。为什么？因为继承 QObject 就获得了这四样能力：

```
                      ┌─────────────┐
                      │   QObject   │
                      └──────┬──────┘
        ┌──────────┬─────────┼─────────┬──────────┐
        ▼          ▼         ▼         ▼          ▼
   ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
   │ 信号与槽 │ │ 线程亲和 │ │ 父子对象 │ │ 动态属性 │
   │ connect │ │绑定事件 │ │setParent│ │setProperty│
   │         │ │ 循环   │ │ 级联析构 │ │元对象系统 │
   └────────┘ └────────┘ └────────┘ └────────┘
```

而这四样能力背后站着同一个支撑者——**元对象系统**。C++ 本身没有反射（不能在运行时查询"这个类有哪些方法、哪些属性"），Qt 自己造了一套。理解了它，QObject 的种种"魔法"就都不再神秘。

## 2. 元对象系统：moc 干了什么

元对象系统由三部分组成：`QObject` 基类、`Q_OBJECT` 宏、**moc（元对象编译器）**。其中 moc 是关键——它是一个编译前的代码生成器：

```
 你的头文件                 moc 处理              编译
 ┌──────────────────┐    ┌──────────┐    ┌────────────────┐
 │ class Foo:QObject │    │  扫描到   │    │ moc_foo.cpp    │
 │ { Q_OBJECT        │───▶│ Q_OBJECT │───▶│ 生成的注册代码   │──▶ 参与链接
 │   signals: ...    │    │ 生成代码  │    │ 元方法/属性表    │
 │ }                 │    └──────────┘    └────────────────┘
```

你在头文件里写的 `Q_OBJECT`、`signals:`、`Q_PROPERTY`、`Q_INVOKABLE`，本身不产生任何代码；moc 扫描到它们后，生成一个 `moc_xxx.cpp`，里面是类的元方法表、属性表、信号实现等注册代码，一起参与编译链接。运行时 Qt 就靠这张表做反射。

由此解释一个新手必遇的报错：加了 `Q_OBJECT` 后链接报 `undefined reference to vtable for "Foo"`——九成是 moc 没跑（或跑了没重编）。CMake 下确认 `CMAKE_AUTOMOC ON`，然后清构建重来即可。

## 3. 信号与槽

### 3.1 解耦的本质

信号与槽要解决的问题用一张图说清：

```
 直接回调（耦合）               信号与槽（解耦）
 ┌──────────┐                ┌──────────┐
 │ 模块A     │── 持有指针 ──▶ │ 模块B     │
 │ 调 b->fn()│                │          │
 └──────────┘                └──────────┘
  A 必须认识 B                ┌──────────┐      ┌──────────┐
                              │ 模块A     │      │ 模块B     │
                              │ emit 信号 │ ···▶ │ 槽函数    │
                              └──────────┘      └──────────┘
                               关联由第三方 connect 决定，
                               A 和 B 互不认识 ★
```

发射者只负责"喊一声"，谁在听、听不听得见，完全由 `connect()` 决定。模块之间不需要互相持有指针，这是 Qt 程序解耦的根基。

### 3.2 Qt 6 的 connect 写法

Qt 6 唯一推荐的是**函数指针语法**：

```cpp
connect(sender, &Sender::valueChanged,
        receiver, &Receiver::onValueChanged);
```

它编译期做类型检查——信号和槽参数不匹配直接编译报错。Qt4/5 时代的字符串语法（`SIGNAL()`/`SLOT()`）只能在运行时报错（`No such signal...`），属于遗留写法，新代码不要再用了。

信号的定义规则记住三条：只声明不实现（实现由 moc 生成）；返回值必须 `void`；可以重载。重载信号 connect 时要消歧义：

```cpp
// QOverload 写法
connect(spinBox, QOverload<int>::of(&QSpinBox::valueChanged),
        this, &MyWidget::onIntChanged);

// 或 static_cast 写法（等价，看团队习惯）
connect(spinBox, static_cast<void(QSpinBox::*)(int)>(&QSpinBox::valueChanged),
        this, &MyWidget::onIntChanged);
```

槽也可以直接是 lambda，此时第三个参数（context）不是摆设：

```cpp
connect(worker, &Worker::progress, this, [this](int percent) {
    updateBar(percent);   // this 作为 context：this 销毁后连接自动断开
});
```

**context 对象决定连接的生命周期**——不传 context 的 lambda 连接，接收方对象销毁后信号照样触发 lambda，捕获的指针就成了野指针。这是信号槽最高发的崩溃来源之一。

连接类型（Direct / Queued / Auto……）已在 P1-02 §5 完整讲过，这里只补一个冷门的：`Qt::SingleShotConnection`——槽触发一次后连接自动断开，适合"只等一次结果"的场景。

### 3.3 信号槽的类型限制与注册

为什么信号槽对参数类型有限制？关键在跨线程（队列连接）场景：信号发出时槽并不立即执行，参数必须先**拷贝一份**存进事件里排队——而 Qt 没法拷贝一个"它不认识"的类型：

```
 信号发出（线程A）              槽执行（线程B）
 ┌──────────────┐            ┌──────────────┐
 │ 拷贝参数      │  事件排队   │ 取出参数      │
 │ 存入事件  ────┼──────────▶ │ 调用槽函数    │
 └──────────────┘            └──────────────┘
      ★ 拷贝需要知道类型的构造/析构 → 这就是"注册"的意义
```

能通过信号槽传递的类型分几档：基本类型天然支持；Qt 内置类型（QString、QPoint 等）已注册；QVariant 本身是万能容器；**自定义类型必须注册**：

```cpp
// 1. 定义类型（需要默认构造、拷贝构造、析构可用）
struct UserInfo {
    QString name;
    int age = 0;
};

// 2. 编译期：让模板代码认识这个类型（QVariant::fromValue 也依赖它）
Q_DECLARE_METATYPE(UserInfo)

// 3. 运行期：注册类型名，供队列连接查表（首次 connect 之前）
qRegisterMetaType<UserInfo>("UserInfo");

// 之后即可用于信号槽
signals:
    void userUpdated(const UserInfo &info);
```

两个宏的分工记法：`Q_DECLARE_METATYPE` 管编译期，`qRegisterMetaType` 管运行期。只同线程用（直接连接）不注册也能跑；跨线程没注册就会报 `QObject::connect: Cannot queue arguments of type 'UserInfo'`。

Qt 自动注册的类型无需手动声明，常见的有：QObject 派生类的指针、元素类型已注册的 `QList<T>`/`QMap<K,V>` 等容器、`QPointer<T>` 等智能指针、`Q_ENUM`/`Q_FLAG` 注册的枚举、以及带 `Q_GADGET` 的类。

**一个能绕开整套注册的捷径**：`QMetaObject::invokeMethod()` 的 lambda 形式。lambda 捕获的参数被拷贝进事件随队列走，不经元类型系统：

```cpp
// 子线程把结果带回主线程（widget 是主线程对象）——UserInfo 无需注册
QMetaObject::invokeMethod(widget, [widget, result]() {
    widget->setText(result.name);     // 这段 lambda 在主线程执行
}, Qt::QueuedConnection);
```

这个写法还能当"延迟执行"用——把代码排队到事件循环下一轮，相当于 `setTimeout(0)`：

```cpp
QMetaObject::invokeMethod(this, [this]() {
    init();   // 当前事件处理完后再执行（构造函数里不能做的事常这么办）
}, Qt::QueuedConnection);
```

注意 lambda 捕获对象指针时，若目标可能在执行前销毁，用 `QPointer` 捕获并判空。

### 3.4 Q_GADGET：轻量版元对象

`Q_OBJECT` 要求必须继承 QObject，但值类型（小结构体）不想背 QObject 的开销，又想要反射能力（属性、枚举、QML 可见）——这时用 `Q_GADGET`：

```cpp
class Point3D
{
    Q_GADGET
    Q_PROPERTY(qreal x MEMBER x)
    Q_PROPERTY(qreal y MEMBER y)
    Q_PROPERTY(qreal z MEMBER z)

public:
    qreal x = 0, y = 0, z = 0;

    enum class Axis { X, Y, Z };
    Q_ENUM(Axis)   // 枚举注册进元系统，QML 里可用

    Q_INVOKABLE qreal length() const {
        return std::sqrt(x * x + y * y + z * z);
    }
};
Q_DECLARE_METATYPE(Point3D)
```

```
           Q_OBJECT              Q_GADGET
 继承要求   必须继承 QObject      无需继承（值类型友好）
 信号/槽    ✔ 支持               ✘ 不支持
 Q_PROPERTY ✔                    ✔
 Q_INVOKABLE✔                    ✔（只能被元调用/QML 反射调用）
 Q_ENUM     ✔                    ✔
 典型用途   有生命周期的对象      值类型、坐标、配置项
```

一句话：**Q_GADGET 是"不要信号槽、只要反射"的轻量选择**，常用于给 QML 暴露值类型。

## 4. 线程亲和性：为什么对象要绑定线程

QObject 的"绑定事件循环"（P1-02 §4 的线程亲和性）本质是为了解决线程安全。思路很直接：多线程有竞态，但如果规定**这个对象只能由指定线程访问**，不就等效于单线程环境了？

```
   任意线程的调用
        │
        ▼
 ┌──────────────┐   是   ┌──────────────┐
 │ 当前线程 == 对 │──────▶│ 直接执行      │
 │ 象绑定的线程？ │       └──────────────┘
 └──────┬───────┘
        │ 否
        ▼
 ┌──────────────────┐   ┌──────────────┐
 │ 压入对象绑定线程的 │──▶│ 该线程事件循环 │
 │ 事件队列等待执行   │   │ 取出并执行    │
 └──────────────────┘   └──────────────┘
        所有访问收敛到同一条线程 ──▶ 等效单线程，无竞态 ★
```

队列连接的信号槽、元调用，走的就是图中"否"的那条路。判断当前位置用：

```cpp
Q_ASSERT(QThread::currentThread() == object->thread());
```

代价当然也有：每次跨线程都要走事件队列，性能不是极限。追求极限性能的场景（如音视频管线）需要自己处理互斥竞态——那是 P1-03 §6.4 的话题。

## 5. 对象树与所有权

`QObject::setParent()`（或构造时传 parent）建立父子树。规则只有一条：**父对象析构时，带走整棵子树**。

```
        window
        ├─ layout
        │   ├─ buttonA ──┐
        │   └─ buttonB   │ window 析构
        └─ statusBar ◀───┘ 整棵树自动销毁
```

这条规则让内存管理从"逐个 delete"变成"管好树形关系"——顶层对象销毁，一切随之清理。对动态分配的 QObject，这基本消灭了泄漏。

两个必须知道的陷阱：

1. **父子必须同属一条线程**（P1-02 的亲和性规则）。跨线程的对象不能建立父子关系，Worker 因此强制无 parent（见 P1-03 §6.1）。
2. **双重所有权**：栈对象或手动 delete 的对象如果同时挂在父子树上，销毁顺序不对就是二次释放。经典翻车：栈上 QWidget 挂到堆上窗口下，窗口先析构已删了它，栈展开又删一次。原则——**挂上树的 QObject 一律堆分配，销毁交给树**。

树之外的销毁需求用 `deleteLater()`：不是立即 delete，而是 post 一个延迟删除事件，等当前事件处理完、回到事件循环时再销毁。跨线程销毁、槽函数里自销毁（`delete this` 的合法替代）都靠它。

## 6. 属性系统与动态属性

`Q_PROPERTY` 声明的属性是元对象系统的一等公民：

```cpp
Q_PROPERTY(int percent READ percent WRITE setPercent NOTIFY percentChanged)
```

它值钱的不是 getter/setter，而是**NOTIFY 信号 + 元系统可见**——QML 的属性绑定、属性动画、`QPropertyAnimation`、Qt 样式表的 `qproperty-*`，全都建立在这张属性表上。可以说 Q_PROPERTY 是 C++ 和 QML 之间的桥（QML 线会反复用到）。

另一层是**动态属性**：`setProperty("key", value)` / `property("key")`，运行时给任意 QObject 挂数据，不需要提前声明。它主要支撑框架底层运作（如样式系统），日常开发用得不多，知道有这回事即可。

整条"宏 → moc → QML 可见"的链路：

```
 C++ 头文件中的宏           moc 处理              结果
 ┌──────────────────┐   ┌──────────┐   ┌────────────────┐
 │ Q_PROPERTY        │   │  moc     │   │ 生成注册代码     │
 │ Q_INVOKABLE       │──▶│ 扫描识别 │──▶│ moc_xxx.cpp    │──▶ QML 可访问
 │ Q_ENUM / Q_FLAG   │   │          │   │ 注册到元对象系统 │
 └──────────────────┘   └──────────┘   └────────────────┘
```

要点：**QML 只能访问经元系统注册的属性和方法**——普通 C++ 成员对 QML 不可见。想在 QML 里用，就得过 moc 这道关。

## 7. 事件系统入口

QObject 还是事件分发的终点。每个对象通过虚函数 `event()` 接收事件，再细分到 `mousePressEvent()`、`timerEvent()` 等具体处理函数；`eventFilter()` 则允许一个对象**拦截**另一个对象的事件：

```
 事件到达 receiver
   ├─ 被安装的 eventFilter 拦截？── 是 ──▶ 过滤器处理/放行
   └─ 否 ──▶ receiver->event()
               ├─ 已知类型 → 具体 handler（如 timerEvent）
               └─ 其它     → 默认处理
```

这里点到为止——事件传递的完整机制（尤其 QML 侧的鼠标/触摸事件争夺）在 P1-13 展开。

## 8. 小结

```
 本文要点回顾
  ├─ QObject 四大能力：信号槽、线程亲和、对象树、动态属性
  ├─ 背后统一支撑：元对象系统（moc 生成反射代码）
  ├─ 信号槽：函数指针语法唯一推荐；lambda 必传 context；
  │          跨线程参数要注册元类型（或 invokeMethod 绕过）
  ├─ Q_GADGET：值类型的轻量反射
  ├─ 对象树：parent 析构带走整棵树；树上对象一律堆分配；
  │          树外销毁用 deleteLater
  └─ Q_PROPERTY 是 C++ 与 QML 之间的桥
```

**进阶指引**

- emit 之后底层到底发生了什么（doActivate / queued_activate / QMetaCallEvent）——见 **P2-01** 信号与槽的源码实现；
- 队列连接为什么跨线程安全——见 **P1-02** 事件循环与线程模型；
- 这套元对象能力在 QML 里的完整运用——见 **P1-10** Qt6 模块系统（C++ 导出类型）。

**思考题**

1. 为什么跨线程信号槽要求参数类型注册元类型，而 `invokeMethod` 的 lambda 形式不需要？（提示：参数拷贝发生在哪一层）
2. 栈上创建一个 `QPushButton` 并挂到堆上窗口的父子树下，程序退出时会发生什么？正确的做法是什么？
3. 一个只承载数据的结构体想在 QML 里读取它的字段，用 `Q_OBJECT` 还是 `Q_GADGET`？为什么？
