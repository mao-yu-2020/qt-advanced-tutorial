# P1-09 Widget 与 QML 选型

> 本文基于 **Qt 6.8.3**。本篇是 QML 线的入口：先解决"两套 UI 技术栈怎么选"
> 的问题，再补齐后续各篇需要的 QML 语法最小集。

## 1. 新项目的第一道选择题

Qt 里做界面有两套技术栈并存：传统的 **Qt Widgets** 和现代的 **Qt Quick（QML）**。对 Qt 开发者来说两者其实都要掌握，但一个具体项目的起点必须做选择——选错了，中途换栈约等于重写界面层。

| 维度 | Qt Widgets | Qt Quick / QML |
| --- | --- | --- |
| 定位 | 传统桌面 UI，控件厚重、贴近原生观感 | 现代动态 UI，动画、触控、流畅过渡 |
| 界面描述 | C++ 代码 / Qt Designer 拖控件 + QSS 样式表 | 声明式标记语言（.qml 文件） |
| 渲染方式 | CPU 光栅化（raster），走系统绘图栈 | 场景图（Scene Graph），默认走 GPU |
| 语言 | C++ | QML + JavaScript，逻辑下沉 C++ |
| 典型场景 | 桌面工具、复杂表格/树、IDE 类应用 | 炫酷动效、嵌入式触摸屏、移动端风格 UI |

渲染管线的差异是根本性的：

```
 Qt Widgets                          Qt Quick (QML)
 ┌──────────────┐                    ┌──────────────┐
 │ QWidget 树    │                    │ Item 树       │
 └──────┬───────┘                    └──────┬───────┘
        ▼ paintEvent(QPainter)              ▼ 转换为场景图节点
 ┌──────────────┐                    ┌──────────────┐
 │ CPU 光栅化    │                    │ Scene Graph  │
 │ 逐控件绘制    │                    │ 渲染线程      │
 └──────┬───────┘                    └──────┬───────┘
        ▼                                   ▼
   屏幕位图（CPU）                     GPU 绘制（图形 API）
```

## 2. 窗口模型的本质差异

比渲染更底层的差异是**窗口模型**——它直接决定了两套技术各自能做什么。

**Widget 侧**：窗口句柄分两种情况，这是很多人误解的地方——

- **native widget（原生窗口部件）**：拥有独立的平台窗口句柄（Windows 上是 HWND），可通过 `winId()` 拿到。默认只有**顶层 widget** 是 native 的；
- **alien widget（异形窗口部件）**：子控件默认是 alien 的，**没有**自己的窗口句柄，直接画在顶层窗口的位图上。这是 Qt 的性能优化——省去为每个按钮向系统申请窗口的开销。

注意：对任何子控件调用 `winId()`，Qt 会把它"升级"为 native widget，强制分配真正的窗口句柄。准确的说法是：**不是每个 widget 都天然拥有独立窗口，但任何 widget 都可以通过 winId() 获得一个**。

**QML 侧**：整个应用只有一个 `QQuickWindow`，窗口内部的 Item 只是引擎内部的**场景图节点**，由渲染线程统一绘制——**没有独立的平台窗口，没有句柄**。

```
 Qt Widgets（句柄可多个）          QML（单窗口）
 ┌─ 顶层窗口 (HWND) ────────┐     ┌─ QQuickWindow (HWND) ─┐
 │ ┌─────────┐ ┌─────────┐ │     │ ┌────┐ ┌────┐ ┌────┐ │
 │ │按钮      │ │输入框    │ │     │ │Item│ │Item│ │Item│ │
 │ │(alien,  │ │(alien,   │ │     │ └──▲─┘ └──▲─┘ └──▲─┘ │
 │ │ 无句柄)  │ │ 无句柄)  │ │     │    └──────┼──────┘   │
 │ └─────────┘ └─────────┘ │     │      Scene Graph 渲染  │
 │ ┌─────────────────────┐ │     │      （引擎内部节点）  │
 │ │视频区 widget         │ │     └───────────────────────┘
 │ │winId() → 独立 HWND  │ │            只有 1 个 HWND ★
 │ └─────────────────────┘ │
 └─────────────────────────┘
```

这个差异的实战后果：**widget 可以把窗口句柄交给第三方库渲染**（典型如 SDL——第三方库把 HWND 当普通系统窗口输出画面），而 QML 做不到——Item 没有句柄可交。QML 集成外部渲染要换思路：用 `QQuickFramebufferObject` 把渲染结果作为纹理送进场景图，或在 QML 窗口上叠一个原生窗口（P1-12 场景图和 P3-04 mpv 渲染实战会细讲）。

## 3. 选型决策

```
                要开发什么界面？
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
   桌面工具类      动画/触控丰富     两者都要
   复杂列表表格    现代动态 UI      （混用）
        │             │              │
        ▼             ▼              ▼
   选 Qt Widgets   选 QML       QQuickWidget /
                                createWindowContainer
```

经验补充：

- 桌面工具类、大量复杂列表表格 → Widgets（模型视图体系成熟，见 P1-11）；
- 动画丰富、触控、移动感 UI → QML；
- 两者不互斥，混用机制见 §5；
- 团队维度也要算：C++ 浓度高的团队用 Widgets 上手快；有设计协作、界面迭代频繁的项目用 QML（界面与逻辑分离更彻底）。

## 4. QML 语法要点（最小集）

后续 QML 线各篇需要的语法地基，在这里一次补齐。

### 4.1 import 与基本结构

一个 QML 文件 = import 语句 + 一个根对象：

```qml
import QtQuick
import QtQuick.Controls

Window {
    width: 640
    height: 480
    visible: true
    title: "Hello QML"

    Rectangle {
        anchors.centerIn: parent
        width: 200; height: 100
        color: "lightblue"

        Text {
            anchors.centerIn: parent
            text: "你好，QML"
        }
    }
}
```

Qt 6 中 import 可以省略版本号；对象用 `类型 { 属性: 值 }` 声明，子对象直接嵌套——类似 HTML 的声明式结构。

### 4.2 id 与自定义属性

id 是同文件内引用对象的名字（不是属性，不能用 `root.id` 访问；小写开头、文档内唯一）：

```qml
Rectangle {
    id: root
    width: 200
    Rectangle { width: root.width / 2 }   // 通过 id 引用
}
```

自定义属性的完整语法：

```plain
[default] [final] [required] [readonly] property <type> <name>
```

四个可选修饰符：

- **readonly**：初始化后不能再改；
- **required**：创建实例时必须显式赋值，否则直接报错——自定义组件的"必填参数"；
- **default**：子对象不显式指定属性名时自动装入默认属性（Item 的默认属性是 `data`，所以写子 Item 从不写 `data: [...]`）；
- **final**：禁止派生类型遮蔽同名属性。

每个属性自动附带 `<name>Changed` 信号和 `on<Name>Changed` 处理器——这正是下一节属性绑定的基础。

### 4.3 属性绑定：QML 的灵魂

属性除了赋静态值，还可以**绑定一个表达式**。引擎自动跟踪表达式引用到的所有属性（依赖），任何依赖变化时自动重算：

```qml
Rectangle {
    width: 400; height: 200
    Rectangle {
        width: parent.width / 2   // 绑定：父宽度变化，子宽度自动跟着变
        height: parent.height
        color: "blue"
    }
}
```

```
   parent.width ──┐
                  │  依赖变化
                  ▼  引擎自动重算
        width: parent.width / 2
                  │
                  ▼
            子矩形 width 自动更新
```

这是 QML 与命令式 UI 最本质的区别：**你描述的是"关系"，而不是"步骤"**。C++/Widget 里要手动 connect 信号再 set 的事，在 QML 里一个表达式就声明完了。

★ 高发坑：**在 JavaScript 语句里给已绑定的属性赋静态值，绑定会被永久移除**：

```qml
Rectangle {
    width: 100
    height: width * 2          // 绑定关系

    MouseArea {
        anchors.fill: parent
        onClicked: height = width * 3   // 静态赋值！原绑定被破坏 ★
        // 想保留绑定，应写：
        // onClicked: height = Qt.binding(function() { return width * 3 })
    }
}
```

### 4.4 信号与信号处理器

信号处理语法是 `on<信号名>`（首字母大写），处理器体是一段 JavaScript：

```qml
MouseArea {
    anchors.fill: parent
    onClicked: console.log("被点击了！")
}
```

自定义组件用 `signal` 声明信号，像调函数一样发射：

```qml
// SquareButton.qml
Rectangle {
    id: root
    signal activated(xPosition: real, yPosition: real)
    width: 100; height: 100

    MouseArea {
        anchors.fill: parent
        onPressed: mouse => root.activated(mouse.x, mouse.y)
    }
}

// 使用方
SquareButton {
    onActivated: (xPosition, yPosition) =>
        console.log(`点击位置: ${xPosition}, ${yPosition}`)
}
```

在对象外部或动态连接信号，用 `Connections`：

```qml
Connections {
    target: someButton
    function onClicked() { console.log("外部连接收到了点击") }
}
```

### 4.5 布局定位的两套体系（不要混用）

**anchors（锚点）**：描述元素间的相对位置，适合单个元素相对父元素定位：

```qml
Rectangle {
    anchors.left: parent.left
    anchors.leftMargin: 10
    anchors.verticalCenter: parent.verticalCenter
    width: 100; height: 50
}
```

**定位器与布局**：Row / Column / Grid 自动排列；需要拉伸行为时用 `QtQuick.Layouts` 的 RowLayout 等，配合附加属性：

```qml
import QtQuick.Layouts

RowLayout {
    spacing: 8
    Rectangle { Layout.preferredWidth: 100; Layout.fillHeight: true; color: "tomato" }
    Rectangle { Layout.fillWidth: true; Layout.fillHeight: true; color: "steelblue" }
}
```

★ 同一元素要么走 anchors，要么交给 Layout，**混用会互相打架**。经验法则：相对定位用 anchors；一组元素的规则排列用 Layouts。

### 4.6 JavaScript 的边界

QML 里的 JS 运行在引擎的绑定环境里——**不是浏览器或 Node.js**：没有 DOM、没有 window、没有 setTimeout 那套 Web API。两点纪律：

- JS 语句对属性的静态赋值会破坏绑定（§4.3 的坑）；
- 复杂命令式逻辑（循环、密集计算）写在绑定里会拖性能。官方建议：**绑定只描述属性间的关系，重逻辑下沉 C++**（怎么下沉见 P1-10）。

所以说 QML"语法类似 js"只对了一半——更准确的描述是：一门被 Qt 属性和绑定体系改造过的 JS。

## 5. 混用的姿势与代价

两个方向互相嵌入：

```
   方向一：QML 嵌入 Widget        方向二：Widget 嵌入 QML
 QWidget 界面                    QML 界面
 ┌──────────────┐              ┌──────────────┐
 │ ┌──────────┐ │              │ ┌──────────┐ │
 │ │QQuickWidget│ │             │ │ QWidget   │ │
 │ │ 内嵌 QML  │ │              │ │(包装成    │ │
 │ └──────────┘ │              │ │ 子窗口)   │ │
 │  其它 widget  │              │ └──────────┘ │
 └──────────────┘              │  其它 Item   │
                               └──────────────┘
```

- **QQuickWidget**：把 QML 场景放进 widget 布局。内部走离屏渲染，兼容性最好，但性能有损耗，不适合嵌入太多实例；
- **QWidget::createWindowContainer()**：把 QQuickWindow 包装成 widget 塞进布局。性能更好，但它是真正的原生窗口——有堆叠顺序（z-order）限制：**普通 widget 画不到它上面**（回到 §2 的窗口模型就明白为什么了）。

取舍：少量嵌入图省事用 QQuickWidget；追求性能、能接受原生窗口限制用 createWindowContainer。但混用终究是过渡方案，新项目建议单一栈。

## 6. 小结

```
 本文要点回顾
  ├─ 两套栈：Widgets（CPU 光栅/桌面工具）vs
  │   QML（场景图 GPU/动态触控 UI）
  ├─ 窗口模型：widget 任何控件可 winId() 拿句柄交第三方；
  │   QML 只有一个窗口，Item 无句柄
  ├─ QML 核心：声明式 + 属性绑定（描述关系而非步骤）；
  │   JS 赋值会破绑定；重逻辑下沉 C++
  ├─ 语法地基：import/id/属性修饰符/onXxx/anchors vs Layouts
  └─ 混用：QQuickWidget（省事）vs createWindowContainer
      （性能好但有 z-order 限制）
```

**进阶指引**

- C++ 类型怎么导出给 QML、工程怎么组织——见 **P1-10** Qt6 模块系统；
- QML 的渲染为什么快——见 **P1-12** QML 场景图。

**思考题**

1. 为什么 QML 不能像 widget 那样把某个 Item 的句柄交给 SDL 渲染？从窗口模型解释。
2. `onClicked: height = width * 3` 之后，`height` 还会跟随 `width` 变化吗？怎么写才能保持响应？
3. 一个"左侧数据表格、右侧动画展示面板"的桌面应用，你会怎么选型？如果用混用方案，选哪种嵌入方向，为什么？
