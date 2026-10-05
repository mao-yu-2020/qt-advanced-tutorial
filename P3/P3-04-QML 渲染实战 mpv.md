# P3-04 QML 渲染实战：mpv 渲染进 QML

> 本文基于 **Qt 6.8.3**。定位：P1-12 的实战篇——主线讲了场景图与自定义渲染
> 三条路径，本篇用项目 `common/modules/mpv/` 的真实代码完整走一遍路径三：
> "第三方引擎自产画面"如何挂进 QML 场景图。

场景图节点适用于"自己画图形"的场景，但视频播放不一样——画面是 mpv 解码后由它自己的渲染管线生产的，开发者拿不到像素去填 QSGSimpleRectNode。这类"第三方引擎自产画面"的集成，走的就是 P1-12 说的路径三。

## 1. 为什么不能嵌 QWidget

熟悉 Qt Widgets 的读者可能会想：mpv 支持 wid 嵌入，把一个 QWidget 的 winId 交给 mpv 不就行了？在纯 Widgets 程序里确实可以，但在 QML 里行不通——QML 的 Item 没有独立的窗口句柄，整个窗口只有一个原生句柄，所有 Item 都是场景图绘制出来的"虚拟元素"。因此唯一的路就是让 mpv 把画面渲染成一张 OpenGL 纹理，再把这张纹理作为场景图的一部分显示。

## 2. 整体结构

项目选型是继承 QQuickFramebufferObject（Qt 官方为"OpenGL 渲染进场景图"准备的现成封装，内部就是 FBO + 纹理节点），整体数据流如下：

```
 ┌──────────────────────────────────────────────────┐
 │ MpvCore（工作线程）                                │
 │  libmpv 解码 ──▶ mpv_render_context（OpenGL 渲染）│
 └──────────────────────┬───────────────────────────┘
                        │ mpv_render_context_render()
                        ▼
              ┌──────────────────┐
              │ 中间 FBO          │  尺寸 = 视频原始尺寸
              │（mpv 原样渲染）   │
              └────────┬─────────┘
                       │ glBlitFramebuffer
                       │（Fit/Crop/Stretch 在此实现）
                       ▼
              ┌──────────────────┐
              │ QQuickFBO 目标 FBO│  尺寸 = Item 显示尺寸
              └────────┬─────────┘
                       │ Qt 包装成纹理节点
                       ▼
              ┌──────────────────┐
              │ QML 场景图上屏     │
              └──────────────────┘
```

## 3. 渲染器实现

QQuickFramebufferObject 要求实现一个 Renderer，它运行在渲染线程。创建渲染上下文在 createFramebufferObject() 里完成（此时 OpenGL 上下文已 current）：

```cpp
QOpenGLFramebufferObject *createFramebufferObject(const QSize &size) override
{
    m_size = size;

    if (!m_renderContext && m_core && m_core->mpvHandle()) {
        initializeRenderContext();
    }

    QOpenGLFramebufferObjectFormat format;
    format.setAttachment(QOpenGLFramebufferObject::CombinedDepthStencil);
    format.setInternalTextureFormat(GL_RGBA8);
    return new QOpenGLFramebufferObject(size, format);
}
```

initializeRenderContext() 里创建 mpv 的 OpenGL 渲染上下文，并注册帧更新回调：

```cpp
mpv_opengl_init_params glInitParams;
glInitParams.get_proc_address = getProcAddress;
glInitParams.get_proc_address_ctx = nullptr;

mpv_render_param params[] = {
    {MPV_RENDER_PARAM_API_TYPE, const_cast<char *>(MPV_RENDER_API_TYPE_OPENGL)},
    {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &glInitParams},
    {MPV_RENDER_PARAM_INVALID, nullptr}
};

if (mpv_render_context_create(&m_renderContext, mpv, params) < 0) {
    qCritical() << "MpvPlayer: failed to create mpv render context";
    return;
}

mpv_render_context_set_update_callback(
    m_renderContext,
    [](void *ctx) {
        auto *core = static_cast<MpvCore *>(ctx);
        if (core) {
            QMetaObject::invokeMethod(
                core,
                &MpvCore::onRenderUpdateRequested,
                Qt::QueuedConnection);
        }
    },
    m_core);
```

真正的渲染在 render() 里：mpv 先渲染到与视频同尺寸的中间 FBO，再按填充模式 blit 到目标 FBO：

```cpp
void render() override
{
    QOpenGLContext *ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions *gl = ctx ? ctx->functions() : nullptr;
    if (!gl) {
        return;
    }

    // 目标 FBO 必须在 mpv 渲染之前记录：mpv 渲染完会把绑定留在中间 FBO 上，
    // 之后再读 GL_FRAMEBUFFER_BINDING 拿到的是中间 FBO，会 blit 到自己身上（表现为不渲染）
    GLint dstHandle = 0;
    gl->glGetIntegerv(GL_FRAMEBUFFER_BINDING, &dstHandle);

    // ……上下文未就绪或视频尺寸未知时清黑目标 FBO，避免花屏……

    // 中间 FBO 与视频同尺寸：mpv 以默认 keepaspect 渲染恰好 1:1 落满
    if (!m_videoFbo || m_videoFbo->size() != QSize(videoW, videoH)) {
        delete m_videoFbo;
        m_videoFbo = new QOpenGLFramebufferObject(videoW, videoH);
    }

    mpv_opengl_fbo videoFbo;
    videoFbo.fbo = static_cast<int>(m_videoFbo->handle());
    videoFbo.w = videoW;
    videoFbo.h = videoH;
    videoFbo.internal_format = 0;

    int flipY = 0;
    mpv_render_param params[] = {
        {MPV_RENDER_PARAM_OPENGL_FBO, &videoFbo},
        {MPV_RENDER_PARAM_FLIP_Y, &flipY},
        {MPV_RENDER_PARAM_INVALID, nullptr}
    };
    mpv_render_context_render(m_renderContext, params);

    // ……按 fillMode 计算源/目标矩形，glBlitFramebuffer 拷贝到目标 FBO……
}
```

这里"中间 FBO + blit"的设计有个实际收益：Fit/Crop/Stretch 三种填充模式全部由 blit 时的源/目标矩形计算实现，绕开了 mpv render API 自带的 panscan/video-crop 适配层（项目注释里注明该组合行为不可靠，是实测结论）。

## 4. 帧驱动的重绘链路

视频画面是持续变化的，谁来触发 QML 重绘？答案是 mpv 的帧更新回调，整条链路如下：

```
 mpv 内部线程：解码出新帧
      │ mpv_render_context_set_update_callback 注册的回调被调用
      │ ★ 回调里禁止直接调 mpv render API，只能"通知"
      ▼
 QMetaObject::invokeMethod(core, onRenderUpdateRequested,
                           Qt::QueuedConnection)   ← 排队到核心线程
      ▼
 MpvCore::onRenderUpdateRequested()  ── emit updateRequested()
      ▼ （QueuedConnection 到 GUI 线程）
 MpvPlayer::onUpdateRequested()  ── 调用 QQuickItem::update()
      ▼
 下一帧同步点：渲染线程执行 Renderer::render()
      ▼
 mpv_render_context_render() 真正画进 FBO ──▶ 场景图上屏
```

这条链路体现了两个硬性约束：

+ **mpv 的 update 回调可以在任意线程触发，且回调内不允许调用任何 mpv render API**（文档原话是只能做 wakeup 类操作）。项目用 QueuedConnection 的 invokeMethod 把通知转回核心线程，再经信号转发到 GUI 线程调 update()，全程没有直接调用；
+ **mpv_render_context_render() 必须在 OpenGL 上下文 current 的线程调用**。QQuickFramebufferObject 恰好保证 render() 在渲染线程执行且上下文已 current，所以二者天然契合——这也是为什么选 QQuickFramebufferObject 而不是自己撸 QSGNode。

另外注意 Renderer 与 Item 之间靠 synchronize() 同步数据：GUI 线程的 fillMode 属性在同步点被渲染线程拉取（`MpvPlayer::setFillMode()` 改完属性后主动调 update() 触发一次重绘），这正是前面"同步点语义"的实际应用。


## 5. 小结

```
 mpv 进 QML 的要点回顾
 ├─ 选型：QQuickFramebufferObject——render() 保证在渲染
 │   线程执行且 GL 上下文 current，与 mpv render API 天然契合
 ├─ 数据流：mpv → 中间 FBO（视频原尺寸）→ glBlitFramebuffer
 │   （Fit/Crop/Stretch）→ 目标 FBO → 场景图纹理上屏
 ├─ 帧驱动：mpv update 回调（禁调 render API）→ 元调用排队
 │   → 核心线程 → GUI 线程 update() → 同步点 render()
 ├─ 数据同步：Renderer 与 Item 靠 synchronize() 在同步点
 │   交接（fillMode 等属性）
 └─ 红线回顾：回调内禁止直接调 mpv render API；
     render() 必须在 GL 上下文 current 的线程（P1-12 两线程模型）
```

**进阶指引**

- 场景图两线程模型与三条渲染路径——见 **P1-12**；为什么 QML Item 没有窗口句柄可交给 mpv——见 **P1-09**。
