# P2-02 QThread 与事件循环的实现

> 本文基于 **Qt 6.8.3** 源码（Windows 平台事件分发器，建议配合 P1-05 配置
> 源码调试）。定位：P1-02 / P1-03 的深挖篇——主线给出的多条红线（事件循环
> 不可阻塞、跨线程事件如何到达 receiver 等），都能在本篇找到底层依据。
> 信号槽自身的调用链（doActivate / queued_activate）见 P2-01。

## 1. 全景地图

先看地图，再进源码——整条事件分发链路如下：

```
  QEventLoop::exec()
        │
        ▼
  eventDispatcher->processEvents()     ← QEventDispatcherWin32
        │
        ▼
  sendPostedEvents()                   ← 逐个取出 postEventList 中的事件
        │
        ▼
  QCoreApplication::sendEvent()
        │
        ▼
  notifyInternal2() ──▶ doNotify()
        │
        ▼
  receiver->event()                    ← QWidget::event() / QObject::event()
```

## 2. 每条线程的家底：QThreadData 与 TLS

先看每条线程的"家底"：QThread 内部持有的是一个 `QThreadData` 底层数据，而 `QThreadData` 基于 **TLS（线程局部存储）** 实现——**每一条线程拥有自己独立的 QThreadData**，互不冲突。

```
   线程 A              线程 B
 ┌───────────┐      ┌───────────┐
 │QThreadData│      │QThreadData│   ← 各自独立（TLS）
 │ ├ eventLoops    │ ├ eventLoops
 │ ├ postEventList │ ├ postEventList
 │ └ eventDispatcher│ └ eventDispatcher
 └───────────┘      └───────────┘
```

QThreadData 相关定义文件：

```cpp
class QThreadData
{
public:
    QThreadData(int initialRefCount = 1);
    ~QThreadData();

    // 返回当前线程的tls对象
    static Q_AUTOTEST_EXPORT QThreadData *current(bool createIfNecessary = true);
    static void clearCurrentThreadData();
    static QThreadData *get2(QThread *thread)
    { Q_ASSERT_X(thread != nullptr, "QThread", "internal error"); return thread->d_func()->data; }


    void ref();
    void deref();
    inline bool hasEventDispatcher() const
    { return eventDispatcher.loadRelaxed() != nullptr; }
    QAbstractEventDispatcher *createEventDispatcher();
    QAbstractEventDispatcher *ensureEventDispatcher()
    {
        QAbstractEventDispatcher *ed = eventDispatcher.loadRelaxed();
        if (Q_LIKELY(ed))
            return ed;
        return createEventDispatcher();
    }

    bool canWaitLocked()
    {
        QMutexLocker locker(&postEventList.mutex);
        return canWait;
    }

private:
    QAtomicInt _ref;

public:
    int loopLevel;
    int scopeLevel;

    /*
     * QEventLoop堆栈管理列表，在QEventLoop::exec()函数调用时，则是会压入到这个列表中去。
     * 如果收到了退出事件，那么exec()退出时，又会将当前堆栈进行移除。
    */
    QStack<QEventLoop *> eventLoops;		

    QPostEventList postEventList;
    QAtomicPointer<QThread> thread;
    QAtomicPointer<void> threadId;

    /*
     * 事件分发执行的函数，它的子类是QEventDispatcherWin32，在调用processEvents()函数处理事件时。
     * 会将其转换为windows的MSG事件进行执行，一直等待interup(中断)标志被设置为true就退出。
    */
    QAtomicPointer<QAbstractEventDispatcher> eventDispatcher;
    QList<void *> tls;

    bool quitNow;
    bool canWait;
    bool isAdopted;
    bool requiresCoreApplication;
};
```

## 3. QThreadData 的创建：current()

那么，这个"每条线程一份"的 QThreadData 是怎么来的？在文件 `qthread_win.cpp` 中可以查阅到 `QThreadData::current()` 函数的具体实现：

```cpp
QThreadData *QThreadData::current(bool createIfNecessary)
{
    qt_create_tls();
    QThreadData *threadData = reinterpret_cast<QThreadData *>(TlsGetValue(qt_current_thread_data_tls_index));
    if (!threadData && createIfNecessary) {
        threadData = new QThreadData;
        // This needs to be called prior to new AdoptedThread() to
        // avoid recursion.
        TlsSetValue(qt_current_thread_data_tls_index, threadData);
        QT_TRY {
            threadData->thread = new QAdoptedThread(threadData);
        } QT_CATCH(...) {
            TlsSetValue(qt_current_thread_data_tls_index, 0);
            threadData->deref();
            threadData = 0;
            QT_RETHROW;
        }
        threadData->deref();
        threadData->isAdopted = true;
        threadData->threadId.storeRelaxed(reinterpret_cast<Qt::HANDLE>(quintptr(GetCurrentThreadId())));

        if (!QCoreApplicationPrivate::theMainThread) {
            QCoreApplicationPrivate::theMainThread = threadData->thread.loadRelaxed();
        } else {
            HANDLE realHandle = INVALID_HANDLE_VALUE;
            DuplicateHandle(GetCurrentProcess(),
                    GetCurrentThread(),
                    GetCurrentProcess(),
                    &realHandle,
                    0,
                    FALSE,
                    DUPLICATE_SAME_ACCESS);
            qt_watch_adopted_thread(realHandle, threadData->thread);
        }
    }
    return threadData;
}
```

## 4. 事件分发器的挂接

事件分发器是由外部通过 QThread 设置进来的：

```cpp
void QThread::setEventDispatcher(QAbstractEventDispatcher *eventDispatcher)
{
    Q_D(QThread);
    if (d->data->hasEventDispatcher()) {
        qWarning("QThread::setEventDispatcher: An event dispatcher has already been created for this thread");
    } else {
        // 事件派遣跟线程绑定在一起/
        eventDispatcher->moveToThread(this);
        if (eventDispatcher->thread() == this) // was the move successful?
            d->data->eventDispatcher = eventDispatcher;
        else
            qWarning("QThread::setEventDispatcher: Could not move event dispatcher to target thread");
    }
}
```

## 5. 线程的创建：QThread::start()

数据结构和分发器都就位了，接下来看 QThread 创建一个线程的处理：

```cpp
void QThread::start(Priority priority)
{
    Q_D(QThread);
    QMutexLocker locker(&d->mutex);

    if (d->isInFinish) {
        locker.unlock();
        wait();
        locker.relock();
    }

    if (d->running)
        return;

    // avoid interacting with the binding system
    d->objectName = d->extraData ? d->extraData->objectName.valueBypassingBindings()
                                 : QString();
    d->running = true;
    d->finished = false;
    d->exited = false;
    d->returnCode = 0;
    d->interruptionRequested = false;

    /*
      NOTE: we create the thread in the suspended state, set the
      priority and then resume the thread.

      since threads are created with normal priority by default, we
      could get into a case where a thread (with priority less than
      NormalPriority) tries to create a new thread (also with priority
      less than NormalPriority), but the newly created thread preempts
      its 'parent' and runs at normal priority.
    */
#if defined(Q_CC_MSVC) && !defined(_DLL)
    // MSVC -MT or -MTd build
    d->handle = (Qt::HANDLE) _beginthreadex(NULL, d->stackSize, QThreadPrivate::start,
                                            this, CREATE_SUSPENDED, &(d->id));
#else
    // MSVC -MD or -MDd or MinGW build
    d->handle = CreateThread(nullptr, d->stackSize,
                             reinterpret_cast<LPTHREAD_START_ROUTINE>(QThreadPrivate::start),
                             this, CREATE_SUSPENDED, reinterpret_cast<LPDWORD>(&d->id));
#endif

    if (!d->handle) {
        qErrnoWarning("QThread::start: Failed to create thread");
        d->running = false;
        d->finished = true;
        return;
    }

    int prio;
    d->priority = priority;
    switch (priority) {
    case IdlePriority:
        prio = THREAD_PRIORITY_IDLE;
        break;

    case LowestPriority:
        prio = THREAD_PRIORITY_LOWEST;
        break;

    case LowPriority:
        prio = THREAD_PRIORITY_BELOW_NORMAL;
        break;

    case NormalPriority:
        prio = THREAD_PRIORITY_NORMAL;
        break;

    case HighPriority:
        prio = THREAD_PRIORITY_ABOVE_NORMAL;
        break;

    case HighestPriority:
        prio = THREAD_PRIORITY_HIGHEST;
        break;

    case TimeCriticalPriority:
        prio = THREAD_PRIORITY_TIME_CRITICAL;
        break;

    case InheritPriority:
    default:
        prio = GetThreadPriority(GetCurrentThread());
        break;
    }

    if (!SetThreadPriority(d->handle, prio)) {
        qErrnoWarning("QThread::start: Failed to set thread priority");
    }

    if (ResumeThread(d->handle) == (DWORD) -1) {
        qErrnoWarning("QThread::start: Failed to resume new thread");
    }
}
```

## 6. exec() 开启事件循环

线程跑起来之后，我们知道 `QThread::exec()` 会开启事件循环，那么它做了什么呢？

```cpp
int QThread::exec()
{
    Q_D(QThread);
    const auto status = QtPrivate::getBindingStatus(QtPrivate::QBindingStatusAccessToken{});

    QMutexLocker locker(&d->mutex);
    d->m_statusOrPendingObjects.setStatusAndClearList(status);
    d->data->quitNow = false;
    if (d->exited) {
        d->exited = false;
        return d->returnCode;
    }
    locker.unlock();

    // 创建一个本地线程循环
    QEventLoop eventLoop;
    // 执行这个循环
    int returnCode = eventLoop.exec();

    locker.relock();
    d->exited = false;
    d->returnCode = -1;
    return returnCode;
}
```

## 7. 线程入口：QThreadPrivate::start()

线程启动后执行的入口是 `QThreadPrivate::start()`，它最后会调用 `QThread::run()`，而 `run()` 又会调用 `exec()`：

```cpp
unsigned int __stdcall QT_ENSURE_STACK_ALIGNED_FOR_SSE QThreadPrivate::start(void *arg) noexcept
{
    QThread *thr = reinterpret_cast<QThread *>(arg);
    QThreadData *data = QThreadData::get2(thr);

    qt_create_tls();
    TlsSetValue(qt_current_thread_data_tls_index, data);
    data->threadId.storeRelaxed(reinterpret_cast<Qt::HANDLE>(quintptr(GetCurrentThreadId())));

    QThread::setTerminationEnabled(false);

    {
        QMutexLocker locker(&thr->d_func()->mutex);
        data->quitNow = thr->d_func()->exited;
    }

    data->ensureEventDispatcher();
    data->eventDispatcher.loadRelaxed()->startingUp();

#if !defined(QT_NO_DEBUG) && defined(Q_CC_MSVC)
    // sets the name of the current thread.
    qt_set_thread_name(HANDLE(-1), thr->d_func()->objectName.isEmpty()
                        ? thr->metaObject()->className()
                        : std::exchange(thr->d_func()->objectName, {}).toLocal8Bit().constData());
#endif

    emit thr->started(QThread::QPrivateSignal());
    QThread::setTerminationEnabled(true);

    // 调用run()函数进行执行
    thr->run();

    finish(arg);
    return 0;
}
```

## 8. 嵌套事件循环："套娃"为什么不卡死

很多人一定很好奇：我们可以用 `QEventLoop` 在当前位置阻塞等待某个条件，但程序的整体事件循环并不会因此卡死。这是为什么？

```cpp
int QEventLoop::exec(ProcessEventsFlags flags)
{
    Q_D(QEventLoop);
    auto threadData = d->threadData.loadRelaxed();

    //we need to protect from race condition with QThread::exit
    QMutexLocker locker(&static_cast<QThreadPrivate *>(QObjectPrivate::get(threadData->thread.loadAcquire()))->mutex);
    if (threadData->quitNow)
        return -1;

    if (d->inExec) {
        qWarning("QEventLoop::exec: instance %p has already called exec()", this);
        return -1;
    }

    struct LoopReference {
        QEventLoopPrivate *d;
        QMutexLocker<QMutex> &locker;

        bool exceptionCaught;
        LoopReference(QEventLoopPrivate *d, QMutexLocker<QMutex> &locker) : d(d), locker(locker), exceptionCaught(true)
        {
            d->inExec = true;
            d->exit.storeRelease(false);

            auto threadData = d->threadData.loadRelaxed();
            ++threadData->loopLevel;

            // 压入一个事件循环
            threadData->eventLoops.push(d->q_func());

            locker.unlock();
        }

        ~LoopReference()
        {
            if (exceptionCaught) {
                qWarning("Qt has caught an exception thrown from an event handler. Throwing\n"
                         "exceptions from an event handler is not supported in Qt.\n"
                         "You must not let any exception whatsoever propagate through Qt code.");
            }
            locker.relock();
            auto threadData = d->threadData.loadRelaxed();

            // 弹出一个事件循环
            QEventLoop *eventLoop = threadData->eventLoops.pop();
            Q_ASSERT_X(eventLoop == d->q_func(), "QEventLoop::exec()", "internal error");
            Q_UNUSED(eventLoop); // --release warning
            d->inExec = false;
            --threadData->loopLevel;
        }
    };
    LoopReference ref(d, locker);

    // remove posted quit events when entering a new event loop
    QCoreApplication *app = QCoreApplication::instance();
    if (app && app->thread() == thread())
        QCoreApplication::removePostedEvents(app, QEvent::Quit);

    // 事件循环一直等待到退出标志被设置为true
    while (!d->exit.loadAcquire())
        processEvents(flags | WaitForMoreEvents | EventLoopExec);

    ref.exceptionCaught = false;
    return d->returnCode.loadRelaxed();
}
```

其实你可以理解为：**一条线程上的 QEventLoop 是可以像套娃一样堆栈嵌套的，但它们运行的是同一个事件分发器实体**，所以外层事件循环不受影响。用一张图看这个"套娃"结构：

```
  线程的 eventLoops 栈
 ┌─────────────────────────────┐
 │  QEventLoop(内层) ← 你在等待 │   栈顶：当前运行的循环
 │  QEventLoop(外层)           │   比如主事件循环
 └─────────────────────────────┘
        共享同一个 eventDispatcher ★
        事件照常分发，互不阻塞
```


每一层 `QEventLoop::exec()` 里循环调用的 `processEvents()`，做的事情其实很薄——只是把活转交给事件分发器：

```cpp
bool QEventLoop::processEvents(ProcessEventsFlags flags)
{
    Q_D(QEventLoop);

    // 获取到线程变量底层数据
    auto threadData = d->threadData.loadRelaxed();
    if (!threadData->hasEventDispatcher())
        return false;

    // 执行这个底层数据相关的事件派遣
    return threadData->eventDispatcher.loadRelaxed()->processEvents(flags);
}
```

这个机制很有用：**它是异步编程的基础**。很多时候我们需要在当前函数里等待某个条件达成后才往下执行，但又不能因此阻塞事件循环——这时就可以创建一个 `QEventLoop`，调用它的 `exec()` 等待条件达成后退出。

## 9. 发动机：QEventDispatcherWin32::processEvents

那么，事件循环的真正"发动机"在哪里呢？

它会调用 `QAbstractEventDispatcher::processEvents()` 接口进行事件处理和分发，一直等到事件分发器的 `interrupt`（中断）标志被设置为 true，才退出这一层循环：

```cpp
bool QEventDispatcherWin32::processEvents(QEventLoop::ProcessEventsFlags flags)
{
    Q_D(QEventDispatcherWin32);

    // We don't know _when_ the interrupt occurred so we have to honor it.
    const bool wasInterrupted = d->interrupt.fetchAndStoreRelaxed(false);
    emit awake();

    // To prevent livelocks, send posted events once per iteration.
    // QCoreApplication::sendPostedEvents() takes care about recursions.

    /*
     * 这里是执行qt事件的地方也就是会处理threadData.postEventList的地方。
     * void QCoreApplicationPrivate::sendPostedEvents(QObject *receiver, int event_type,
                                               QThreadData *data);
     * 上面的函数就是把这种事件进行处理，QT的事件就是基于这一套来处理的。
     * 经过一些列操作，最终会调用到QObject::event();函数处理上，之后会区分异步元调用事件，还是其它事件。
     */
    sendPostedEvents();

    if (wasInterrupted)
        return false;

    auto threadData = d->threadData.loadRelaxed();
    bool canWait;
    bool retVal = false;
    do {
        QVarLengthArray<MSG> processedTimers;

        // 检测中断标志是否被设置为true
        while (!d->interrupt.loadRelaxed()) {
            MSG msg;

            if (!(flags & QEventLoop::ExcludeUserInputEvents) && !d->queuedUserInputEvents.isEmpty()) {
                // 用户的输入事件
                // process queued user input events
                msg = d->queuedUserInputEvents.takeFirst();
            } else if (!(flags & QEventLoop::ExcludeSocketNotifiers) && !d->queuedSocketEvents.isEmpty()) {
                // 套接字事件
                // process queued socket events
                msg = d->queuedSocketEvents.takeFirst();
                
            } else if (PeekMessage(&msg, 0, 0, 0, PM_REMOVE)) {
                // windows系统事件，在转换为QT事件口 
                
                if (flags.testFlag(QEventLoop::ExcludeUserInputEvents)
                    && isUserInputMessage(msg.message)) {
                    // queue user input events for later processing
                    // 将用户输入事件排队以供以后处理
                    d->queuedUserInputEvents.append(msg);
                    continue;
                }
                if ((flags & QEventLoop::ExcludeSocketNotifiers)
                    && (msg.message == WM_QT_SOCKETNOTIFIER && msg.hwnd == d->internalHwnd)) {
                    // queue socket events for later processing
                    // 将套接字事件排队以供以后处理
                    d->queuedSocketEvents.append(msg);
                    continue;
                }
            } else if (MsgWaitForMultipleObjectsEx(0, NULL, 0, QS_ALLINPUT, MWMO_ALERTABLE)
                       == WAIT_OBJECT_0) {
                // a new message has arrived, process it
                // 有新消息来了，处理它（这还是windows事件）
                continue;
            } else {
                // nothing to do, so break
                break;
            }

             // wakeUp()唤醒消息
            if (d->internalHwnd == msg.hwnd && msg.message == WM_QT_SENDPOSTEDEVENTS) {               
                d->startPostedEventsTimer();
                // Set result to 'true' because the message was sent by wakeUp().
                retVal = true;
                continue;
            }

            // 定时器事件
            if (msg.message == WM_TIMER) {
                // Skip timer event intended for use inside foreign loop.
                if (d->internalHwnd == msg.hwnd && msg.wParam == d->sendPostedEventsTimerId)
                    continue;

                // avoid live-lock by keeping track of the timers we've already sent
                bool found = false;
                for (int i = 0; !found && i < processedTimers.count(); ++i) {
                    const MSG processed = processedTimers.constData()[i];
                    found = (processed.wParam == msg.wParam && processed.hwnd == msg.hwnd && processed.lParam == msg.lParam);
                }
                if (found)
                    continue;

                // 加到定时器事件列表
                processedTimers.append(msg);
                
            } else if (msg.message == WM_QUIT) {

                // 程序发生退出事件
                if (QCoreApplication::instance())
                    QCoreApplication::instance()->quit();
                return false;
            }

            // 消息不用过滤就执行
            if (!filterNativeEvent(QByteArrayLiteral("windows_generic_MSG"), &msg, 0)) {

                // 转发和执行事件
                TranslateMessage(&msg);
                DispatchMessage(&msg);
            }
            retVal = true;
        }

        // wait for message
        canWait = (!retVal
                   && !d->interrupt.loadRelaxed()
                   && flags.testFlag(QEventLoop::WaitForMoreEvents)
                   && threadData->canWaitLocked());
        if (canWait) {
            emit aboutToBlock();
            MsgWaitForMultipleObjectsEx(0, NULL, INFINITE, QS_ALLINPUT, MWMO_ALERTABLE | MWMO_INPUTAVAILABLE);
            emit awake();
        }
    } while (canWait);

    return retVal;
}
```

上面的代码注释已经解释过了：`sendPostedEvents()` 就是 Qt 事件的实际处理点。

## 10. 事件出队：sendPostedEvents

下面这个函数解释了它如何把 `QThreadData::postEventList` 里的事件拿出来逐个处理。源码较长，这里只保留主干逻辑（循环框架 + 取出事件 + 投递主路径），异常安全清理与 DeferredDelete 特殊处理从略，完整实现见 Qt 源码 `qcoreapplication.cpp`：

```cpp
void QCoreApplicationPrivate::sendPostedEvents(QObject *receiver, int event_type,
                                               QThreadData *data)
{
    /*
     * 不要被receiver与event_type给误导了，这两个的值都固定为0。
    */
    if (event_type == -1) {
        // we were called by an obsolete event dispatcher.
        event_type = 0;
    }

    // 这里不会成立
    if (receiver && receiver->d_func()->threadData.loadRelaxed() != data) {
        qWarning("QCoreApplication::sendPostedEvents: Cannot send "
                 "posted events for objects in another thread");
        return;
    }

    ++data->postEventList.recursion;

    auto locker = qt_unique_lock(data->postEventList.mutex);

    // by default, we assume that the event dispatcher can go to sleep after
    // processing all events. if any new events are posted while we send
    // events, canWait will be set to false.
    data->canWait = (data->postEventList.size() == 0);

    if (data->postEventList.size() == 0 || (receiver && !receiver->d_func()->postedEvents)) {
        --data->postEventList.recursion;
        return;
    }

    data->canWait = true;

    // okay. here is the tricky loop. be careful about optimizing
    // this, it looks the way it does for good reasons.
    qsizetype startOffset = data->postEventList.startOffset;
    qsizetype &i = (!event_type && !receiver) ? data->postEventList.startOffset : startOffset;
    data->postEventList.insertionOffset = data->postEventList.size();

    // ... 异常安全清理与 DeferredDelete 特殊处理从略，详见 Qt 源码 ...

    while (i < data->postEventList.size()) {
        // avoid live-lock
        if (i >= data->postEventList.insertionOffset)
            break;

        const QPostEvent &pe = data->postEventList.at(i);
        ++i;

        if (!pe.event)
            continue;

        // 这一条不会成立
        if ((receiver && receiver != pe.receiver) || (event_type && event_type != pe.event->type())) {
            data->canWait = false;
            continue;
        }

        // ... 异常安全清理与 DeferredDelete 特殊处理从略，详见 Qt 源码 ...

        // 主要看下面这一段代码
        // first, we diddle the event so that we can deliver
        // it, and that no one will try to touch it later.
        pe.event->m_posted = false;
        QEvent *e = pe.event;
        QObject * r = pe.receiver;

        --r->d_func()->postedEvents;
        Q_ASSERT(r->d_func()->postedEvents >= 0);

        // next, update the data structure so that we're ready
        // for the next event.
        const_cast<QPostEvent &>(pe).event = nullptr;

        locker.unlock();
        const auto relocker = qScopeGuard([&locker] { locker.lock(); });

        QScopedPointer<QEvent> event_deleter(e); // will delete the event (with the mutex unlocked)

        // after all that work, it's time to deliver the event.
        QCoreApplication::sendEvent(r, e);

        // careful when adding anything below this point - the
        // sendEvent() call might invalidate any invariants this
        // function depends on.
    }
}
```

## 11. 投递终点：notifyInternal2 与 doNotify

`QCoreApplication::sendEvent(r, e)` 最终会调用下面这个函数：

```cpp
bool QCoreApplication::notifyInternal2(QObject *receiver, QEvent *event)
{
    // 检查是否为主线程
    bool selfRequired = QCoreApplicationPrivate::threadRequiresCoreApplication();

    // 这个是判断有没有创建QCoreApplication这个对象的
    if (!self && selfRequired)
        return false;

    // Make it possible for Qt Script to hook into events even
    // though QApplication is subclassed...
    bool result = false;
    void *cbdata[] = { receiver, event, &result };
    if (QInternal::activateCallbacks(QInternal::EventNotifyCallback, cbdata)) {
        return result;
    }

    // Qt enforces the rule that events can only be sent to objects in
    // the current thread, so receiver->d_func()->threadData is
    // equivalent to QThreadData::current(), just without the function
    // call overhead.
    QObjectPrivate *d = receiver->d_func();
    QThreadData *threadData = d->threadData.loadAcquire();
    QScopedScopeLevelCounter scopeLevelCounter(threadData);

    // 子线程就进这里，还有一个原因那就是判断是否为QWidget类型，子线程就只会是继承QObject
    if (!selfRequired)
        return doNotify(receiver, event);

    /*
     * 在主线程就进入这里，但最后都会调用doNotify()，主线程会多判断程序是否已经退出了。
     * 还有一点特别重要的原因，如果你开启了QWidget，那么你定义的就是QApplication，那么它调用的就是QApplication::notify()函数。
     * 它们的处理不一样哦。包括最后的event(),QWidget::event()也是重载了的。
    */
    return self->notify(receiver, event);
}
```

注意，它后面还需要判断 `isWidgetType()`——这是为了防止 QWidget 类型的对象误入 QObject 的处理路径。

如果你用的是 QWidget，那么最后的 `event()` 进入的是 `QWidget::event()`，而不是 `QObject::event()`：

```cpp
static bool doNotify(QObject *receiver, QEvent *event)
{
    Q_ASSERT(event);

    // ### Qt 7: turn into an assert
    if (receiver == nullptr) {                        // serious error
        qWarning("QCoreApplication::notify: Unexpected null receiver");
        return true;
    }

#ifndef QT_NO_DEBUG
    QCoreApplicationPrivate::checkReceiverThread(receiver);
#endif

    /*
     * 这里是判断是否为Widget，子线程就可能是widget，如果是主线程开了widget，那么它进入的就是QApplcation::notify()处理;
     */
    return receiver->isWidgetType() ? false : QCoreApplicationPrivate::notify_helper(receiver, event);
}
```

至此，一条事件从产生到被 `receiver->event()` 处理的完整链路就走完了。

## 12. 小结

```
 事件分发源码链路回顾
 ├─ 每条线程一份 QThreadData（TLS）：事件队列 +
 │   事件分发器 + 事件循环栈
 ├─ QThread::start() 建线程 → run() → exec() →
 │   QEventLoop::exec() 循环 processEvents
 ├─ 发动机 QEventDispatcherWin32：Windows 消息泵 +
 │   sendPostedEvents() 处理 Qt 事件
 ├─ 出队投递：sendPostedEvents → sendEvent →
 │   notifyInternal2 → doNotify → receiver->event()
 └─ 嵌套 QEventLoop 共享同一分发器：所以"套娃"
     等待时外层循环不卡死
```

回到主线红线的源码印证：

1. **"有事件循环的线程禁止阻塞"**（P1-02 §6）——`sendPostedEvents()` 在同一个调用里串行取事件，任何一个处理函数阻塞，队列里的事件全在排队干等，这就是源码层面的直接证据；
2. **"跨线程事件如何到达 receiver"**（P1-02 §4）——post 的事件进的是 `QThreadData::postEventList`，每条线程一份，由该线程自己的分发器取出——线程亲和性的物理载体就是 QThreadData；
3. **invokeMethod / 队列连接的终点**（P2-01）——QMetaCallEvent 正是经本篇 §10→§11 的链路到达 `receiver->event()` 的。

**进阶指引**

- 跨线程信号槽如何打包出 QMetaCallEvent——见 **P2-01**；
- 建议按 P1-05 配好源码调试后，在 `sendPostedEvents()` 打断点，观察一次队列连接的完整投递过程。
