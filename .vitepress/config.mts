import { defineConfig } from 'vitepress'

// GitHub Pages 项目站点需要 base = '/<仓库名>/'，通过环境变量注入；
// 本地开发不设置 BASE，默认为 '/'
const base = process.env.VITEPRESS_BASE || '/'

export default defineConfig({
  base,
  lang: 'zh-CN',
  title: 'Qt 进阶教程',
  description: '基于 Qt 6.8.3 的 Qt 进阶教程：主线教程 + 源码原理 + 项目实战',
  lastUpdated: true,
  cleanUrls: true,
  markdown: {
    lineNumbers: true
  },
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: 'P1 主线教程', link: '/P1/P1-00-前言' },
      { text: 'P2 源码原理', link: '/P2/P2-01-信号与槽的源码实现' },
      { text: 'P3 项目实战', link: '/P3/P3-01-日志实战 spdlog 封装' },
      { text: '附录', link: '/appendix/附录B-常见问题 FAQ' }
    ],
    sidebar: [
      {
        text: '开始',
        items: [
          { text: '教程规划', link: '/00-教程重构规划' }
        ]
      },
      {
        text: 'P1 主线教程',
        collapsed: false,
        items: [
          { text: 'P1-00 前言', link: '/P1/P1-00-前言' },
          { text: 'P1-01 QObject 与元对象系统', link: '/P1/P1-01-QObject 与元对象系统' },
          { text: 'P1-02 事件循环与线程模型', link: '/P1/P1-02-事件循环与线程模型' },
          { text: 'P1-03 QThread 与多线程实践', link: '/P1/P1-03-QThread 与多线程实践' },
          { text: 'P1-04 Qt 日志系统', link: '/P1/P1-04-Qt 日志系统' },
          { text: 'P1-05 Qt 调试与开发效率', link: '/P1/P1-05-Qt 调试与开发效率' },
          { text: 'P1-06 Qt 插件机制', link: '/P1/P1-06-Qt 插件机制' },
          { text: 'P1-07 Qt 国际化', link: '/P1/P1-07-Qt 国际化' },
          { text: 'P1-08 Qt 数据库', link: '/P1/P1-08-Qt 数据库' },
          { text: 'P1-09 Widget 与 QML 选型', link: '/P1/P1-09-Widget 与 QML 选型' },
          { text: 'P1-10 Qt6 模块系统', link: '/P1/P1-10-Qt6 模块系统' },
          { text: 'P1-11 模型与视图', link: '/P1/P1-11-模型与视图' },
          { text: 'P1-12 QML 场景图', link: '/P1/P1-12-QML 场景图' },
          { text: 'P1-13 QML 事件处理', link: '/P1/P1-13-QML 事件处理' },
          { text: 'P1-14 QML 对象所有权与 GC', link: '/P1/P1-14-QML 对象所有权与 GC' },
          { text: 'P1-15 Qt Android 开发', link: '/P1/P1-15-Qt Android 开发' }
        ]
      },
      {
        text: 'P2 源码原理',
        collapsed: false,
        items: [
          { text: 'P2-01 信号与槽的源码实现', link: '/P2/P2-01-信号与槽的源码实现' },
          { text: 'P2-02 QThread 与事件循环的实现', link: '/P2/P2-02-QThread 与事件循环的实现' },
          { text: 'P2-03 插件系统的四个核心宏', link: '/P2/P2-03-插件系统的四个核心宏' },
          { text: 'P2-04 翻译工具链手册', link: '/P2/P2-04-翻译工具链手册' }
        ]
      },
      {
        text: 'P3 项目实战',
        collapsed: false,
        items: [
          { text: 'P3-01 日志实战 spdlog 封装', link: '/P3/P3-01-日志实战 spdlog 封装' },
          { text: 'P3-02 数据库实战 LocalDbService', link: '/P3/P3-02-数据库实战 LocalDbService' },
          { text: 'P3-03 模型视图实战', link: '/P3/P3-03-模型视图实战' },
          { text: 'P3-04 QML 渲染实战 mpv', link: '/P3/P3-04-QML 渲染实战 mpv' },
          { text: 'P3-05 插件实战 MySQL 驱动编译', link: '/P3/P3-05-插件实战 MySQL 驱动编译' },
          { text: 'P3-06 Android 实战 Activity 与 JNI', link: '/P3/P3-06-Android 实战 Activity 与 JNI' }
        ]
      },
      {
        text: '附录',
        collapsed: false,
        items: [
          { text: '附录A 实用技巧 svgtoqml', link: '/appendix/附录A-实用技巧 svgtoqml' },
          { text: '附录B 常见问题 FAQ', link: '/appendix/附录B-常见问题 FAQ' }
        ]
      }
    ],
    outline: {
      label: '本页目录',
      level: [2, 3]
    },
    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    },
    lastUpdated: {
      text: '最后更新'
    },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
          modal: {
            noResultsText: '没有找到结果',
            resetButtonTitle: '清除搜索',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' }
          }
        }
      }
    }
  }
})
