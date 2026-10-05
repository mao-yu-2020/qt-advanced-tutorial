# P3-05 插件实战：MySQL 驱动编译

> 本文基于 **Qt 6.8.3**。定位：P1-06 的实战篇——MySQL 驱动是最常需要自己
> 编译的高级插件（QSqlDriverPlugin）。Qt 官方二进制包**不自带 MySQL 驱动**
> （Qt 6 只附带 SQLite，Windows 另有 ODBC / PostgreSQL），用 QMYSQL 必须自己编。

## 1. 编译前的准备

三样东西必须备齐：

1. **与当前 Qt 完全相同版本的源码**——通过维护工具（MaintenanceTool）勾选 Sources 安装（版本不一致可能因 API 变化编译失败）；
2. **MySQL C 库**——需包含 `lib/libmysql.lib`、`lib/libmysql.dll`、`include/mysql.h`，且**位数（x86/x64）与 Qt 套件一致**。Windows 平台安装完整 MySQL Server x64 即包含 C API 库（8.0.19 起不再提供独立 C Connector 安装项，也可改用 MariaDB C Connector）；
3. **对应 Qt 的命令行环境**——Windows 开始菜单中打开对应 Qt 版本的命令行（确保编译环境就绪）。

## 2. Qt 6 方式：qt-cmake 单独构建 sqldrivers（官方推荐）

Qt 6 不需要重新编译整个 Qt，**只单独构建源码中的 sqldrivers 插件目录**：

```bat
mkdir build-sqldrivers
cd build-sqldrivers
C:\Qt\6.8.3\msvc2022_64\bin\qt-cmake -G Ninja C:\Qt\6.8.3\Src\qtbase\src\plugins\sqldrivers ^
    -DCMAKE_INSTALL_PREFIX=C:\Qt\6.8.3\msvc2022_64 ^
    -DMySQL_ROOT="C:\mysql-8.0.22-winx64"
cmake --build .
cmake --install .
```

流程与检查点：

```
 qt-cmake 配置 ──▶ 看输出摘要：MySql ... yes ? ★
      │ no
      │   └─▶ 删 CMakeCache.txt 重配；或改用精确路径：
      │        -DMySQL_INCLUDE_DIR="...\include"
      │        -DMySQL_LIBRARY="...\lib\libmysql.lib"
      ▼ yes
 cmake --build . ──▶ cmake --install .
      ▼
 插件进入 C:\Qt\6.8.3\msvc2022_64\plugins\sqldrivers\
```

验证：程序里 `qDebug() << QSqlDatabase::drivers();` 输出包含 `"QMYSQL"` 即成功。

## 3. 分发注意事项

插件编出来了，部署到用户机器还有两条依赖链要带齐：

```
 你的 exe
   ├─ plugins\sqldrivers\qsqlmysql.dll   ← 驱动插件本体
   │     （按插件目录约定放置，见 P1-06 §4）
   └─ libmysql.dll                        ← MySQL C 库，放 exe 同级
         └─ 依赖 MSVC 运行库 → 用 vcredist.exe 安装
```

少任何一环，加载失败时用 P1-06 的排查组合：`QT_DEBUG_PLUGINS=1` + `QT_LOGGING_RULES=qt.sql.*.debug=true`，配合 Dependencies / dumpbin 查看 qsqlmysql.dll 的依赖缺口。

## 4. Qt 5 方式：qmake（遗留项目参考）

> Qt 5 时代的方法，仅维护老项目时参考；新项目请用 §2。

Qt 源码自带驱动插件项目，路径形如 `Qt\5.15.2\Src\qtbase\src\plugins\sqldrivers\mysql`。修改该目录下 mysql 的 `.pro` 文件，补 MySQL C 库路径：

```cpp
TARGET = qsqlmysql
HEADERS += $$PWD/qsql_mysql_p.h
SOURCES += $$PWD/qsql_mysql.cpp $$PWD/main.cpp
OTHER_FILES += mysql.json
PLUGIN_CLASS_NAME = QMYSQLDriverPlugin
include(../qsqldriverbase.pri)

# MySQL C 库的头文件路径
INCLUDEPATH += "C:\Program Files\MySQL\MySQL Server 8.0\include"
# libmysql 的 .lib 路径
LIBS += -L"C:\Program Files\MySQL\MySQL Server 8.0\lib" -l"libmysql"
```

编译后在输出目录执行 `nmake install` 安装到 Qt 环境，并把 **libmysql.dll** 拷到 Qt 的 bin 目录。

## 5. 小结

```
 MySQL 驱动编译要点回顾
 ├─ 为什么自己编：官方二进制包不带（许可证/分发原因）
 ├─ 前提：同版本 Qt 源码 + MySQL C 库（位数一致）
 ├─ Qt 6：qt-cmake 单编 sqldrivers 目录，
 │   配置摘要确认 MySql ... yes 再 build/install
 ├─ 验证：QSqlDatabase::drivers() 含 QMYSQL
 └─ 分发：插件 dll + libmysql.dll + vcredist 三件套
```

**进阶指引**

- 插件机制与加载失败排查清单——见 **P1-06**；数据库的使用与线程红线——见 **P1-08**。
