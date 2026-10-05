# 附录 B 常见问题 FAQ

> 高频问题的速查索引。每条给一句话答案 + 详细讲解所在篇目。

## QTableWidget 添加/修改数据时卡顿严重

检查标题头是否设成了 `QHeaderView::ResizeToContents`——每次增改都会全表重算列宽，O(n²) 噩梦。改用 `Stretch` 或 `Interactive`。
→ 详解：**P1-05 §2**（含排查方法论）；同类陷阱清单见 **P1-11 §6**。

## Qt 在线安装/维护工具下载太慢

命令行加 `--mirror` 切国内镜像源（中科大/清华/北理/南大），安装器和 MaintenanceTool 通用。
→ 详解：**P1-05 §3**。

## 断点进不去 Qt 内部函数 / 进去只有汇编

需要：① 维护工具勾选 Sources 源码；② Qt Creator 调试器里配"调试符号路径 → 本机源码路径"的映射。
→ 详解：**P1-05 §1**。

## 跨线程信号槽传自定义类型报错 `Cannot queue arguments of type 'Xxx'`

自定义类型要 `Q_DECLARE_METATYPE` + `qRegisterMetaType` 注册；或者用 `QMetaObject::invokeMethod` 的 lambda 形式绕过。
→ 详解：**P1-01 §3.3**；源码级原因见 **P2-01**。

## 加了 Q_OBJECT 链接报 `undefined reference to vtable`

九成是 moc 没跑或没重编。确认 CMake `AUTOMOC` 开启（`qt_standard_project_setup()` 默认已开），清构建目录重来。
→ 详解：**P1-01 §2**。

## 插件编译成功却加载失败

`loader.errorString()` + `QT_DEBUG_PLUGINS=1`，按"位数/编译器/IID/依赖/目录"五项清单排查。
→ 详解：**P1-06 §5**。

## Qt 模块自己的 debug 日志看不到

Qt 默认过滤逻辑硬编码了 `qt.*` 类别的 debug 关闭。加规则 `QT_LOGGING_RULES="qt.*.debug=true"` 打开。
→ 详解：**P1-04 §6**。

## QML 里 TapHandler 不触发，也没有报错

多半是同级有 MouseArea 把事件独占了——两套事件体系互不相认。同一块区域只选一套体系，新代码全用 Handler。
→ 详解：**P1-13**（机制与七条避坑指南）。

## C++ 对象传给 QML 后变成 null / 崩溃（QQmlData::wasDeleted）

对象无 parent 且经方法调用返回，被判为 JavaScriptOwnership，被 GC 回收了。创建时设 parent，或提前 `setObjectOwnership(CppOwnership)`。
→ 详解：**P1-14**。

## MySQL 驱动 `QMYSQL driver not loaded`

官方包不带 MySQL 驱动，需用同版本 Qt 源码自行编译 sqldrivers，并带齐 libmysql.dll。
→ 详解：**P3-05**；加载排查见 **P1-06 §5**。
