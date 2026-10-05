# P1-14 QML 对象所有权与 GC

> 本文基于 **Qt 6.8.3**。本篇是 QML 线的收尾：C++ 对象进入 QML 后的生死归谁管。
> 前置概念：Qt 父子对象树见 P1-01，C++ 类型导出 QML 见 P1-10。
>
> **知识点定位**：当 C++ 代码将 `QObject*` 传递到 QML（JS）环境时，QML 引擎如何决定由谁负责销毁该对象？什么情况下 QML 的垃圾回收器（GC）会 `delete` 你的 C++ 对象？
>
> **典型症状**：在 QML 中通过 C++ 方法获取的对象指针，第一次使用正常，之后突然变成 `null`，甚至引发 `QQmlData::wasDeleted` 崩溃。

在进入细节之前，先用一张图抓住全篇的核心逻辑——任何一个 `QObject*` 进入 QML 引擎时，都会走下面这条判定路径：

```
   QObject* 进入 QML（首次被包装成 JS 对象）
                    │
        所有权是否被显式设置过？
          （setObjectOwnership）
            ┌───────┴───────┐
        是  │               │  否（走默认判定）
            ▼               ▼
      按设置值生效    QObject::parent() 是否为 nullptr？
                      ┌─────┴─────┐
               非空   │           │  空
                      ▼           ▼
               CppOwnership   JavaScriptOwnership
              （QML 永不 delete）（JS 无引用后，GC 会 delete）
```

> 一句话总结：**有没有 `QObject::parent()`，决定了 QML 敢不敢 `delete` 你的对象。**

---

## 1. 问题背景
Qt/QML 允许 C++ 代码将 `QObject*` 直接暴露给 QML 使用。例如：

```cpp
// C++
class DataItem : public QObject { Q_OBJECT ... };

class DataModel : public QAbstractListModel {
    Q_OBJECT
    Q_INVOKABLE DataItem* getItem(int index);  // 返回 QObject*
};
```

```plain
// QML
let item = model.getItem(0)
console.log(item.name)   // 正常
```

但如果 `DataItem` 没有正确处理生命周期，后续访问时 `item` 可能变成 `null`，甚至导致程序崩溃。根本原因是 **QML 引擎的 Object Ownership（对象所有权）机制**。

---

## 2. 核心机制：Object Ownership
当 C++ 的 `QObject*` 首次进入 QML（JavaScript）环境时，QML 引擎会为它创建 JS 包装对象（wrapper），并确定该对象的**所有权归属**：

```cpp
// 查询 / 设置所有权的 API（Qt 6 中定义在 QJSEngine 上，
// QQmlEngine 继承 QJSEngine，因此写 QQmlEngine:: 同样合法）
auto ownership = QQmlEngine::objectOwnership(obj);
QQmlEngine::setObjectOwnership(obj, QQmlEngine::CppOwnership);
```

所有权枚举（`QJSEngine::ObjectOwnership`）只有两个值，对应 QML 对该对象两种截然不同的态度：

| 所有权 | 常量名 | 谁负责 `delete` | QML 是否会 GC |
| --- | --- | --- | --- |
| C++ 所有权 | `CppOwnership` | C++ 代码（你） | ❌ **不会** |
| JavaScript 所有权 | `JavaScriptOwnership` | QML/JS 引擎 | ✅ **会** |

官方文档对数据所有权有一段纲领性表述（[Data Type Conversion Between QML and C++](https://doc.qt.io/qt-6/qtqml-cppintegration-data.html)）：

> 数据从 C++ 传到 QML 时，所有权始终留在 C++。**例外**是：当 QObject 是从一次显式的 C++ 方法调用中返回时，QML 引擎会取得该对象的所有权——除非你已用 `setObjectOwnership()` 显式声明为 `CppOwnership`。此外，QML 引擎尊重 Qt 的父子对象语义，**永远不会 delete 一个有 parent 的 QObject**。

---

## 3. 默认规则详解
### 3.1 完整判定顺序
综合官方文档与 Qt 实现，一个对象的所有权按以下顺序确定：

1. **显式设置优先**：如果曾调用 `QQmlEngine::setObjectOwnership()`，以设置值为准；
2. **有 parent → `CppOwnership`**：`QObject::parent()` 非空的对象，引擎永远不会 delete；
3. **无 parent，但由 QML 引擎自己创建**（如 QML 中声明式 `DataItem {}`、`Qt.createQmlObject()`）：归 QML 引擎管理，属于引擎内部生命周期，不参与"返回裸指针"这条风险路径；
4. **无 parent，且从 C++ 方法调用（`Q_INVOKABLE` / 槽函数返回值）进入 QML → `JavaScriptOwnership`**：这是唯一的"默认把 C++ 对象所有权交给 GC"的路径，也是全部踩坑的来源。

相应的简化伪代码（只对应路径 2 和 4 的常见情况）：

```cpp
// 默认判定逻辑（简化，仅示意）
if (object->parent())
    return CppOwnership;        // 有 parent → C++ 所有权
else
    return JavaScriptOwnership; // 无 parent 且由方法调用返回 → JS 所有权
```

### 3.2 规则总结
| 对象状态 | 默认所有权 | 结果 |
| --- | --- | --- |
| `obj->parent() != nullptr` | `CppOwnership` | QML **不会** 回收，C++ 端负责销毁 |
| `obj->parent() == nullptr`，经方法调用返回 | `JavaScriptOwnership` | QML **会** 在适当时机 GC |
| 通过 `setContextProperty()` 暴露 | 所有权留在 C++ | QML 不会主动 delete，但 C++ 必须保证其存活期覆盖引擎 |
| QML 中声明式创建（`DataItem {}`） | QML 引擎管理 | 随组件/引擎生命周期销毁，C++ 不应 delete |

> ⚠️ **重要**：这里的 "parent" 指的是 Qt 父子对象树中的 parent（`QObject::parent()`），不是 QML Item 的 visual parent（两者关系见 7.2 节）。

---

## 4. JavaScriptOwnership 的 GC 行为
当一个对象被判定为 `JavaScriptOwnership` 时：

1. QML 引擎在 JS 堆中跟踪该对象的包装对象；
2. 当 QML 中不再有任何变量、属性、信号连接或 delegate 实例引用它时，包装对象变为"可回收"；
3. **GC 不是立即运行的**。引擎会在它认为合适的时机（例如新建对象达到一定数量后）自动执行回收；回收时对象被 `delete`；
4. **C++ 端的裸指针此时变成悬空指针（dangling pointer）**。

注意一条官方明确的豁免规则（[QJSEngine::setObjectOwnership](https://doc.qt.io/qt-6/qjsengine.html#setObjectOwnership)）：

> 拥有 `JavaScriptOwnership` 的对象，**只要还有 parent，就不会被垃圾回收**，即使 JS 侧已无任何引用。

### 手动触发 GC（调试用）
排查问题时，等待引擎"择机"GC 会让复现变得飘忽不定。可以调用 `QJSEngine::collectGarbage()` 强制立即回收，让问题稳定复现：

```cpp
// 在某个调试按钮 / 测试代码里
qmlEngine(this)->collectGarbage();   // 或 engine->collectGarbage()
```

### 典型触发场景
+ `ListView` / `GridView` 调用 `beginResetModel()` / `endResetModel()`，旧的 delegate 实例被销毁，其中持有的 JS 引用消失；
+ QML 页面切换，原来的页面及其中所有 JS 变量被释放；
+ 手动将 QML 中的变量设为 `null` 或 `undefined`。

---

## 5. 完整踩坑实例
以下是我们项目中**真实出现的问题**的简化复现：

### 5.1 C++ 端代码
```cpp
// MediaListModelItem.h
struct MediaListModelItem : public QObject
{
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(QString name MEMBER name)

public:
    QString name;
    bool check = false;
};

// MediaListModel.h
class MediaListModel : public QAbstractListModel
{
    Q_OBJECT
    QML_ELEMENT

public:
    Q_INVOKABLE int itemCount() const { return _datas.size(); }

    // ⚠️ 危险：返回 QObject* 到 QML
    Q_INVOKABLE MediaListModelItem* getItem(int index) const {
        return _datas.at(index);  // 返回裸指针
    }

    void appendItem(const QString &name) {
        auto item = new MediaListModelItem;   // ❌ 没有 parent！
        item->name = name;
        _datas.append(item);
    }

    void clear() {
        for (auto *item : _datas)
            delete item;
        _datas.clear();
    }

private:
    QVector<MediaListModelItem*> _datas;
};
```

### 5.2 QML 端代码
```plain
import QtQuick
import MyModule 1.0

Item {
    MediaListModel {
        id: model
        Component.onCompleted: {
            appendItem("图片1")
            appendItem("图片2")
            appendItem("图片3")
        }
    }

    Button {
        text: "第一次获取"
        onClicked: {
            for (let i = 0; i < model.itemCount(); i++) {
                let item = model.getItem(i)
                console.log(item.name, item.check)  // ✅ 正常输出
            }
        }
    }

    Button {
        text: "重置模型（触发GC）"
        onClicked: {
            // 模拟 resetSelection() 的行为
            model.beginResetModel()
            model.endResetModel()
            // 此时 ListView/GridView 的 delegate 重建，旧引用断开
        }
    }

    Button {
        text: "第二次获取（崩溃）"
        onClicked: {
            for (let i = 0; i < model.itemCount(); i++) {
                let item = model.getItem(i)
                console.log(item.name)  // ❌ TypeError: Cannot read property 'name' of null
            }
        }
    }
}
```

### 5.3 问题分析
| 时间点 | 发生了什么 | 对象所有权状态 |
| --- | --- | --- |
| 初始化 | `new MediaListModelItem` 无 parent | 待判定 |
| 第一次获取 | 经 `Q_INVOKABLE` 返回进入 QML，判定为 `JavaScriptOwnership`，JS 持有引用 | 对象存活 |
| 重置模型 | `beginResetModel/endResetModel`，QML 视图重建，旧 delegate 销毁 | JS 引用断开 |
| GC 运行 | 引擎发现对象无 JS 引用，且所有权是 `JavaScriptOwnership` | **对象被 delete** |
| 第二次获取 | C++ 返回悬空指针，QML 包装时发现对象已销毁 | 返回 `null` → TypeError |

整个过程的时间线：

```
  C++ 侧                QML/JS 侧                 对象状态
─────────────────────────────────────────────────────────
  new Item (无parent)                              存活
       │  getItem() 返回
       ├──────────────► 包装为 JS 对象              存活
       │                (JavaScriptOwnership)
  modelReset          delegate 销毁
       ├──────────────► JS 引用全部断开             存活但无引用
       │                GC 运行
       │                引擎 delete 对象            ☠ 已销毁
  _datas 仍存裸指针
       │  getItem() 再次返回
       ├──────────────► 发现对象已销毁 → null       悬空！
```

---

## 6. 修复方案
### 方案一：设置 parent（推荐）
在创建对象时指定 parent，让 QML 自动判定为 `CppOwnership`：

```cpp
void appendItem(const QString &name) {
    auto item = new MediaListModelItem(this);  // ✅ parent = DataModel
    item->name = name;
    _datas.append(item);
}
```

如果对象是从外部传入的，可以在入口兜底：

```cpp
void appendItem(MediaListModelItem *item) {
    if (item && item->parent() != this)
        item->setParent(this);  // ✅ 确保有 parent
    _datas.append(item);
}
```

+ **适用边界**：对象与容器有明确的"同生共死"关系时最合适；parent 销毁会自动 delete 全部 children，`clear()` 里要相应改成只 delete 后从列表移除（避免二次 delete）。
+ **代价**：几乎为零，同时符合 Qt 父子对象树的一贯设计。

### 方案二：显式声明 CppOwnership
如果业务上确实不方便设置 parent（例如对象需要在多个 parent 之间转移，或者根本不该挂进对象树），可以显式设置所有权：

```cpp
#include <QQmlEngine>

void appendItem(const QString &name) {
    auto item = new MediaListModelItem;  // 无 parent
    item->name = name;
    QQmlEngine::setObjectOwnership(item, QQmlEngine::CppOwnership);  // ✅ 显式声明
    _datas.append(item);
}
```

+ **适用边界**：必须保证 C++ 端自己管理 delete（`clear()` 里的 `delete item` 正好承担了这一职责）；且 `setObjectOwnership` 应在对象**首次被 QML 包装之前**调用——对象一旦进入过 QML，引擎内部已缓存了包装数据，之后再改所有权未必按预期生效。
+ **注意**：所有权标记存储在对象自身的元数据里，是全局的、不区分引擎的；同一对象暴露给多个 QQmlEngine 时，设置一次即可（也只生效一份）。

### 方案三：不返回 QObject*（最稳妥）
如果数据只需要在 QML 中读取简单属性，可以通过 `QVariantMap` 或模型角色（`roleNames()` / `data()`）传递，避免暴露原始指针：

```cpp
Q_INVOKABLE QVariantMap getItemData(int index) const {
    auto item = _datas.at(index);
    return QVariantMap{
        {"name", item->name},
        {"check", item->check}
    };
}
```

```plain
let data = model.getItemData(0)
console.log(data.name)  // 安全，不涉及 QObject 生命周期
```

+ **适用边界**：QML 只需要"读快照"的场景；缺点是无法双向交互（QML 改属性不会回写 C++ 对象），且每次调用产生一次拷贝，字段多时有额外开销。
+ **组合建议**：优先方案一；对象生命周期与模型强绑定时，方案一 + 模型角色（`data()`/`setData()`）双管齐下是最健壮的形态；只有在对象不便挂 parent 时才用方案二兜底；方案三适合纯展示数据。

---

## 7. 所有权切换的边界情况
### 7.1 从 QML 创建 C++ 对象
在 QML 中**声明式**创建已注册的 C++ 类型：

```plain
// 声明式创建：由 QML 引擎创建并管理
DataItem {
    name: "hello"
}
```

这类对象由 QML 引擎负责销毁（随组件实例 / 引擎生命周期），C++ 侧拿到这种对象的指针后**不要 delete**。

动态创建时同理：

```plain
let item = Qt.createQmlObject('import MyModule; DataItem {}', parent)
```

+ 第二个参数 `parent` 是 QML 的父对象；指定后对象挂入对应的层级中；
+ 通过 `new`（`QJSEngine::newQMetaObject` 暴露的构造函数）创建的对象明确是 `JavaScriptOwnership`。

### 7.2 QML 的 visual parent ≠ QObject parent
这是最容易混淆的一点：

| 概念 | API | 决定什么 |
| --- | --- | --- |
| QObject parent | `QObject::parent()` / `setParent()` | 所有权判定、对象树析构 |
| visual parent | QML `Item` 的 `parent` 属性（`QQuickItem::parentItem()`） | 渲染层级、坐标系、裁剪 |

两个事实需要同时记住：

1. **所有权判定只看 `QObject::parent()`**。一个 Item 如果没有被放进任何可视层级（没有 visual parent），但 C++ 侧给它 `setParent()` 过，它依然是 `CppOwnership`；反过来也一样。
2. **对 `QQuickItem` 而言，QML 里给 `parent` 属性赋值会同步改变 `QObject::parent()`**——Item 的父子关系会同时反映到 QObject 对象树上。这意味着在 QML 里把一个无 parent 的 Item 挂到另一个 Item 下，它的所有权行为会随之改变（有了 QObject parent 后引擎不再 delete 它）。但对非 Item 的普通 QObject 子类，QML 里并没有"visual parent"概念，不要在 QML 里用 `parent` 属性去赌所有权。

### 7.3 信号参数传递
当 C++ 信号发射 `QObject*` 参数到 QML 槽时：

```cpp
signals:
    void itemAdded(DataItem* item);
```

```plain
onItemAdded: (item) => {
    console.log(item.name)
}
```

信号的参数对象同样遵循上述所有权规则。如果 `item` 没有 parent 且此前未被显式设置所有权，它可能被判为 `JavaScriptOwnership`：QML 槽执行完毕后若不再引用，对象可能被 GC。**信号参数对象建议在发射前 setParent 或 setObjectOwnership**，不要依赖"槽里只用一次所以没事"。

### 7.4 setContextProperty 暴露的对象
按官方"数据所有权"规则，通过 `rootContext()->setContextProperty("backend", obj)` 暴露给 QML 的对象，**所有权留在 C++**（不属于"方法调用返回值"这一例外路径），引擎不会主动 delete 它。但反过来，C++ 必须保证该对象的存活期覆盖引擎的使用期——context property 被 QML 全局引用，对象提前销毁同样会产生悬空。常见做法是以堆对象创建并 parent 到 `QCoreApplication` 或引擎上。

### 7.5 与 `QPointer` / `QWeakPointer` 的区别
| 机制 | 作用 | 适用场景 |
| --- | --- | --- |
| `QPointer` | 指向 QObject 的安全指针，对象被 delete 后自动置为 `nullptr` | C++ 内部使用 |
| `QWeakPointer` | 配合 `QSharedPointer` 使用，不增加引用计数 | C++ 内部使用 |
| `ObjectOwnership` | 决定 QML/JS 是否可以 delete 对象 | C++ ↔ QML 交互 |

> `ObjectOwnership` 解决的是"谁有权利 delete"的问题，而 `QPointer` 解决的是"对象被 delete 后指针是否安全"的问题。两者互补：**C++ 容器里持有可能暴露给 QML 的对象时，用 `QPointer<T>` 存储可以兜底检测悬空**。

---

## 8. 最佳实践清单
- [ ] **创建 QObject 时尽量指定 parent**，既符合 Qt 父子对象树设计，又避免 QML GC 问题
- [ ] **从 C++ 暴露给 QML 的 QObject***，如果无法设置 parent，务必在首次进入 QML 之前调用 `QQmlEngine::setObjectOwnership(obj, QQmlEngine::CppOwnership)`
- [ ] **避免在 C++ 容器中保存无 parent 且所有权为 `JavaScriptOwnership` 的 QObject 裸指针**，这是悬空指针的高危组合；无法避免时用 `QPointer` 存储
- [ ] **优先使用模型角色（`data()` / `setData()`）或 `QVariantMap` 传递数据**，减少直接暴露 QObject 指针的必要性
- [ ] **如果需要暴露 QObject 指针，确保 C++ 端有明确的生命周期管理**，并在对象销毁时从容器中移除
- [ ] **多引擎场景下注意**：`setObjectOwnership` 的标记存在对象自身上、不区分引擎；同一对象给多个引擎用时只需设置一次，但任一引擎的 GC 都可能按该标记 delete 它
- [ ] **排查疑难问题时主动 `collectGarbage()`**：GC 时机不确定会掩盖问题，强制回收让悬空问题立刻现形（仅限调试代码）

---

## 9. 调试与排查
### 如何确认对象当前的所有权？
```cpp
#include <QQmlEngine>

void debugOwnership(QObject *obj) {
    auto ownership = QQmlEngine::objectOwnership(obj);
    if (ownership == QQmlEngine::CppOwnership)
        qDebug() << obj << "has CppOwnership";
    else
        qDebug() << obj << "has JavaScriptOwnership - DANGER!";
}
```

### 如何确认对象是否被 QML GC 回收了？
```cpp
// 在 QObject 子类中添加析构函数日志
~MediaListModelItem() {
    qDebug() << "MediaListModelItem destroyed:" << this << name;
}
```

如果在**没有**调用 C++ 端 `delete` 的情况下看到析构日志，说明对象被 QML GC 回收了。配合下面的强制 GC，可以把"偶发"变成"必现"：

```cpp
// 调试专用：在可疑操作后强制跑一轮 GC
if (auto *e = qmlEngine(this))
    e->collectGarbage();
```

### 典型报错特征
+ `TypeError: Cannot read property 'xxx' of null` —— QML 拿到的对象已被回收，wrapper 解析为 `null`；
+ 崩溃栈中出现 `QQmlData::wasDeleted` / `QV4::QObjectWrapper` 字样 —— 基本可锁定为本章所述的所有权问题。

---

## 10. 参考
+ [Qt 官方文档：Data Type Conversion Between QML and C++（Data Ownership 一节）](https://doc.qt.io/qt-6/qtqml-cppintegration-data.html)
+ [QJSEngine::ObjectOwnership 枚举](https://doc.qt.io/qt-6/qjsengine.html#ObjectOwnership-enum)
+ [QJSEngine::setObjectOwnership / objectOwnership](https://doc.qt.io/qt-6/qjsengine.html#setObjectOwnership)
+ [QJSEngine::collectGarbage（手动触发 GC）](https://doc.qt.io/qt-6/qjsengine.html#collectGarbage)

---

## 小结

```
 本文要点回顾
 ├─ 所有权两态：CppOwnership（QML 永不 delete）/
 │   JavaScriptOwnership（无 JS 引用后 GC 会 delete）
 ├─ 默认判定：有 QObject parent → Cpp 所有权；
 │   无 parent 且经方法调用返回 → JS 所有权（唯一危险路径）★
 ├─ 修复优先级：设 parent（推荐）→ 显式 CppOwnership
 │   → 不返回裸指针（QVariantMap/模型角色）
 ├─ visual parent ≠ QObject parent；信号参数同样守规则
 └─ 排查：析构日志 + collectGarbage() 强制现形
```

**进阶指引**

- Qt 父子对象树与 `deleteLater`——见 **P1-01** QObject 与元对象系统；
- 模型角色传数据（方案三）的完整用法——见 **P1-11** 模型与视图。

**思考题**

1. 为什么"有 parent 的对象永不被 QML GC"这条规则，让 `setParent()` 成为修复 GC 悬空的首选方案？它的代价是什么场景下会显现？
2. `setObjectOwnership()` 为什么要在对象首次进入 QML **之前**调用？之后调用可能发生什么？
3. C++ 信号带 `QObject*` 参数到 QML 槽，发射前应该做什么？不做的话哪条路径会踩坑？
