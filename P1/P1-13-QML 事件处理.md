# P1-13 QML 事件处理

> 本文基于 **Qt 6.8.3**。QML 输入处理最大的坑不在 API，而在**两套并存的事件
> 体系**。本篇从一个经典疑惑出发，讲清事件传递机制，再给出避坑指南。

## 1. 一个经典疑惑：TapHandler 为什么不触发？

先看这段"看起来毫无问题"的代码——MouseArea 和 TapHandler 同级，都想要点击：

```qml
Window {
    width: 640; height: 480; visible: true

    MouseArea {
        anchors.fill: parent
        onClicked: console.log('mouse area ...')     // 触发 ✔
    }

    TapHandler {
        onTapped: console.log('tap handle ...')      // 永远不触发 ✘
    }
}
```

点击之后只有 `mouse area ...`，TapHandler 像不存在一样——**没有报错、没有警告**，静默失效。更迷惑的是：给 MouseArea 设 `mouse.accepted = false` 也救不了它。

要理解这一切，得先看 QML 的事件到底是怎么传递的。

## 2. QML 的事件传递机制

鼠标/触摸事件进入窗口后，**按 Z 顺序自顶向下**访问各个 Item，每层 Item 内部的询问顺序是固定的：

```
  鼠标/触摸事件进入窗口
          │
          ▼
  按 Z 顺序自顶向下访问各个 Item
          │
          ├─ ① 先派发给 Item 上声明的 PointerHandler
          │     （Handler 可以拿"被动抓取"或"独占抓取"）
          │
          └─ ② 再派发给 Item 本身
                   （MouseArea 在这里接收，并默认独占事件）
```

两个关键词：

- **Z 序**：叠在上面的 Item 先被问到。MouseArea 自己就是一个 Item，它和别的 Item 谁先收到事件，取决于堆叠关系；
- **accepted / grab**：Item 体系（MouseArea）靠 `mouse.accepted` 决定"吃不吃掉事件"；Handler 体系靠**抓取（grab）**协商归属——**两套规则互不相认**，这是全部坑的总根源。

## 3. 两套并存的事件体系

```
            MouseArea（老）          PointerHandler（新）
  本质       一个 Item（有内存开销）   非可视处理器，更轻量
  依附方式   自己占据一块区域         attach 到声明它的 Item
  设备支持   鼠标 + 单点触摸          鼠标/触摸/手写笔，可区分
  多点触控   ✘ 做不到                 ✔ PinchHandler 捏合缩放等
  组合方式   一个 Area 全包           一个 Item 可挂多个 Handler
  官方态度   遗留兼容（original）     新代码推荐方向
```

**MouseArea** 是 Qt Quick 早期的产物（官方文档明确称其为"原始的"鼠标处理方式）：一个不可见 Item，通过 `onClicked`、`onPressed` 等信号处理事件，**默认把事件 accept 掉独占**。

**PointerHandler**（Qt 5.10 起、Qt 6 主推）：TapHandler / DragHandler / PinchHandler / HoverHandler / PointHandler 等。它们**不是 Item**，而是依附在声明它的 Item 上的轻量处理器。

### 3.1 事件模型的差别：一个"事件" vs 一串"触摸点"

这是最底层的一个差别，两套体系看到的"输入"压根不是同一种东西：

```
 MouseArea 的世界：QMouseEvent（单个事件对象）
   一次交互 = 一串有先后的事件：
   MouseButtonPress → MouseMove… → MouseButtonRelease → MouseClick
   ★ 隐含假设：全场只有一个鼠标、一个焦点序列（单点设备思维）

 PointerHandler 的世界：QEventPoint（触摸点）
   一次输入 = 若干个并发的"点"，每个点有自己的生命周期：
   pressed → updated… → released   （每个点独立跟踪、独立归属）
   ★ 天生多点：两个手指就是两个并行的 EventPoint
```

MouseArea 继承自 Widgets 时代的鼠标思维：事件是线性的，"谁在接收"是一个全局状态（mouse grabber），所以它能用 `mouse.accepted` 这种布尔标志决定事件去留。而 Handler 体系为触摸时代设计：多个触摸点并发存在，"归属"必须**按点**协商——这就是为什么它引入了抓取（grab）概念。多点触控 MouseArea 做不到，根子就在这里，不是 API 缺功能，是事件模型就不支持。

### 3.2 派发管线的差别：两条并行的投递通道

Qt Quick 窗口收到原始的指针输入后，实际上维护着**两条派发管线**（概念模型，便于理解）：

```
 原始指针输入（QPointerEvent）
        │
        ├─ 管线一：指针事件派发（新）
        │    按 Z 序自顶向下问每个 Item 上的 PointerHandler
        │    归属按 EventPoint 逐个协商（被动/独占抓取）
        │
        └─ 管线二：鼠标事件派发（老，兼容用）
             单点输入被合成为 QMouseEvent，投递给 Item 层级
             MouseArea 在这条管线上接收
             归属是一个全局 mouse grabber Item
```

这解释了 §2 的顺序"先 Handler、再 Item"：同一个 Item 上，管线一（Handler）先于管线二（Item 自身/MouseArea）被询问。也解释了混用为什么静默失效——**TapHandler 在管线一等事件，MouseArea 在管线二把事件吃掉了，两条管线之间没有"转发"关系**。

### 3.3 归属协商的差别：布尔标志 vs 抓取协商

两套体系决定"事件归谁"的方式完全不同：

```
 MouseArea：accepted 布尔标志（事后否决式）
   事件先给你，你在 onPressed 里表态 accepted = true/false
   false → 事件转给 Z 序更低的 Item
   协商范围：仅在 Item 层级间，仅在管线二内有效

 PointerHandler：抓取状态机（事先协商式）
   每个 EventPoint 有三种归属状态：未抓取 / 被动抓取 / 独占抓取
   ├─ 被动抓取：我能持续收到这个点，但不妨碍别人也收到
   └─ 独占抓取：这个点之后只属于我
   grabPermissions 声明"我愿不愿意抢、允不允许被抢"，
   由派发器在点级别自动仲裁，不需要你写否决代码
```

设计思想的差异很清楚了：MouseArea 是"先收到再决定要不要"，否决权在使用者手里，传递路径靠人想明白；Handler 是"先声明意图，框架自动仲裁"——`gesturePolicy` 声明手势判定方式，`grabPermissions` 声明抢占意图，归属协商由派发器完成。后者对"拖动 vs 点击""两个手势竞争"这类场景的表达力强得多，代价是概念多了一层。

### 3.4 为什么互不相认

把三层差别合起来，答案就完整了：

```
 互不相认的三重原因
 ├─ 事件模型不同：QMouseEvent（单点线性）
 │   vs QEventPoint（多点并发）——根本没有共同的"事件"可传
 ├─ 派发管线不同：鼠标合成管线 vs 指针派发管线
 │   ——两条通道之间没有转发机制
 └─ 归属语义不同：accepted 管 Item 层级（管线二），
     grab 管 EventPoint（管线一）——管的不是同一个东西
```

所以 `mouse.accepted = false` 救不了 TapHandler：它只能在管线二里把合成鼠标事件让给下层 Item，而 TapHandler 在管线一等一个永远不会来的指针事件。两个世界各有各的规则——**同级混用时，MouseArea 在管线二独占，管线一的 Handler 只能拿到没人抢的残局**。

回到 §1 的谜题，现在能完整解释了：

```
  事件按下
     │
     ▼
  ┌──────────────┐  accept（默认独占）
  │  MouseArea   │ ──────────────▶ onClicked 触发
  │（叠在上层）  │
  └──────────────┘
     │ 事件被吃掉，不再向下
     ✘
  ┌──────────────┐
  │ Window 内容项 │ ──▶ TapHandler 拿不到事件，不触发
  └──────────────┘
```

TapHandler 声明在 Window 里，attach 目标是 Window 的**内容项**；MouseArea 是填满窗口的上层 Item，先收到事件并独占——事件根本走不到内容项。

## 4. 嵌套的解法与代价

让 TapHandler 触发的办法：把它声明到 MouseArea **内部**——这样它的"管辖项"变成 MouseArea 本身，按 §2 的顺序"先 Handler、再 Item 自己"：

```qml
MouseArea {
    anchors.fill: parent

    TapHandler {
        onTapped: console.log('tap handle ...')   // 先触发（① Handler）
    }
    onClicked: console.log('mouse area ...')      // 后触发（② Item 自己）
}
```

实际输出验证顺序：

```plain
qml: tap handle ...
qml: mouse area ...
```

但代价明显：**两个都会触发**。一次点击两边先后执行，若写的都是"切换页面"就会执行两次——必须自己加状态协调（比如标记"本次已由 TapHandler 处理"，onClicked 里判断后直接返回）。这种"两个都响"的模式本质是手工消抖的临时方案，**不是长久之计**——真正的解法在下面的避坑指南第 1 条。

## 5. 避坑指南七条

### 1. 同一块交互区域，只选一套体系

同级混用是最易踩的坑：事件被 MouseArea 独占后 Handler 静默失效，无报错无警告。同一块区域要么全 MouseArea，要么全 Handler：

```qml
// ✘ 同级混用，TapHandler 永远不触发
Item {
    MouseArea { anchors.fill: parent; onClicked: console.log("area") }
    TapHandler { onTapped: console.log("tap") }
}

// ✔ 只用 Handler 体系
Item {
    TapHandler { onTapped: console.log("tap") }
    HoverHandler { id: hover }
}
```

### 2. 新代码直接用 Handler 替代 MouseArea

Handler 不是 Item，开销更小、能力更全：

```qml
Rectangle {
    width: 120; height: 40
    color: tap.pressed ? "steelblue" : "lightgray"

    TapHandler {
        id: tap
        acceptedButtons: Qt.LeftButton | Qt.RightButton
        gesturePolicy: TapHandler.ReleaseWithinBounds  // 拖出再松开即取消，类似按钮
        margin: 8                                       // 边缘外 8px 内也算点中
        onTapped: (eventPoint, button) => console.log("tapped:", button)
    }
}
```

注意 `gesturePolicy` 默认是 `DragThreshold`：移动超过拖拽阈值就取消手势，此时 Handler 只拿**被动抓取**，不干扰别人——"增强"现有控件用默认值，做按钮设 `ReleaseWithinBounds`。

### 3. 多点触控只能用 PinchHandler

MouseArea 设计上就是单点设备，双指捏合、旋转无从表达。涉及多点触控没有选择余地：

```qml
Image {
    source: "photo.jpg"
    PinchHandler { target: parent }   // 捏合直接缩放/旋转这个 Image
}
```

### 4. 拖动用 DragHandler 的 target，别手动算坐标

```qml
Rectangle {
    id: handle
    width: 50; height: 50; color: "tomato"
    DragHandler {
        // target 默认就是 handle，也可指定拖别的 Item
        yAxis.minimum: 0
        yAxis.maximum: 200
    }
}
```

### 5. 悬停用 HoverHandler；MouseArea 的 hoverEnabled 也是坑

MouseArea 默认**不处理悬停**——`onEntered`、`containsMouse` 要先设 `hoverEnabled: true` 才工作，忘了就是"不报错但不触发"的哑坑。HoverHandler 声明即生效：

```qml
Rectangle {
    width: 100; height: 40
    color: hover.hovered ? "wheat" : "beige"
    HoverHandler {
        id: hover
        cursorShape: Qt.PointingHandCursor
    }
}
```

### 6. 抢事件用 grabPermissions，不是 accepted

Handler 体系的"事件归属"靠抓取管理：

```
 抓取（grab）的两种形态
 ├─ 被动抓取（passive grab）：保证收到该触摸点的后续
 │   移动和释放，但不阻止别人也收到
 └─ 独占抓取（exclusive grab）：之后只发给我一个人
```

`grabPermissions` 决定"能不能抢、让不让别人抢"，默认值已覆盖大多数场景（允许从 Item 手里接管，也允许别人来接管）。发现 Handler"和别的行为冲突"时，官方建议的顺序：**先想清楚 gesturePolicy，解决不了再调 grabPermissions——永远不要指望 `mouse.accepted`，那不属于 Handler 世界**。

### 7. "点击空白处取消"用挂在背景项上的 TapHandler

弹窗/下拉菜单的"点空白关闭"，正确做法是在背景遮罩项上挂 TapHandler，而不是塞 MouseArea 再转发：

```qml
Rectangle {                          // 全屏半透明遮罩
    anchors.fill: parent
    color: "#80000000"
    visible: popup.visible
    TapHandler { onTapped: popup.close() }
}
```

配合默认的被动抓取，它不会挡住遮罩上方弹窗自身的交互。

## 6. 小结

```
 本文要点回顾
  ├─ 事件按 Z 序自顶向下；每层 Item 内"先 Handler 再 Item"
  ├─ 深层差别：QMouseEvent 单点线性 vs QEventPoint 多点并发；
  │   两条派发管线无转发；accepted vs grab 管的不是一回事
  ├─ 同级混用 = Handler 静默失效；嵌套混用 = 两个都响
  ├─ 新代码全用 Handler：Tap/Drag/Pinch/Hover
  ├─ 冲突调解顺序：gesturePolicy → grabPermissions，
  │   永远不指望 mouse.accepted
  └─ MouseArea 只在维护老代码时碰
```

**进阶指引**

- Item 为什么"叠在上面先收到"——Z 序与场景图绘制顺序见 **P1-12**；
- QML 对象生命周期与内存（Handler/Item 的所有权归属）——见 **P1-14**。

**思考题**

1. MouseArea 里嵌套一个 TapHandler，点击后两个都会触发——如果想"只让 TapHandler 响应"，有哪些做法？各自的代价是什么？
2. 为什么 `mouse.accepted = false` 无法把事件让给同层 Item 上的 TapHandler？用两套体系的传播路径解释。
3. 一个可拖动又可点击的卡片（拖动超过阈值算拖、否则算点击），用 Handler 体系怎么组合实现？`gesturePolicy` 该用哪个？
