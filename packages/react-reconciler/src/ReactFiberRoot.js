/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {RootTag} from 'shared/ReactRootTags';
import type {TimeoutHandle, NoTimeout} from './ReactFiberHostConfig';
import type {Thenable} from './ReactFiberWorkLoop';
import type {Interaction} from 'scheduler/src/Tracing';
import type {SuspenseHydrationCallbacks} from './ReactFiberSuspenseComponent';
import type {ReactPriorityLevel} from './SchedulerWithReactIntegration';

import {noTimeout} from './ReactFiberHostConfig';
import {createHostRootFiber} from './ReactFiber';
import {NoWork} from './ReactFiberExpirationTime';
import {
  enableSchedulerTracing,
  enableSuspenseCallback,
} from 'shared/ReactFeatureFlags';
import {unstable_getThreadID} from 'scheduler/tracing';
import {NoPriority} from './SchedulerWithReactIntegration';

// TODO: This should be lifted into the renderer.
export type Batch = {
  _defer: boolean,
  _expirationTime: ExpirationTime,
  _onComplete: () => mixed,
  _next: Batch | null,
};

export type PendingInteractionMap = Map<ExpirationTime, Set<Interaction>>;

type BaseFiberRootProperties = {|
  // The type of root (legacy, batched, concurrent, etc.)
  // 用于标记fiberRoot的类型(LegacyRoot，BatchedRoot，ConcurrentRoot等等)
  tag: RootTag,

  // Any additional information from the host associated with this root.
  // 和fiberRoot关联的DOM容器的相关信息
  containerInfo: any,
  // Used only by persistent updates.
  // 该属性仅用于持久更新中
  // 遍历当前正在进行任务调度的workInProgress节点的所有child节点
  // 根据child节点的tag标记类型生成与之对应的持久化数据并添加到pendingChildren队列中
  // 这部分的内容感兴趣的朋友可以自己探究下
  pendingChildren: any,
  // The currently active root fiber. This is the mutable root of the tree.
  // 指向当前激活的与之对应的rootFiber节点
  current: Fiber,

  pingCache:
    | WeakMap<Thenable, Set<ExpirationTime>>
    | Map<Thenable, Set<ExpirationTime>>
    | null,

  // 表示当前任务完成时所对应的过期时间
  finishedExpirationTime: ExpirationTime,
  // A finished work-in-progress HostRoot that's ready to be committed.
  // 已经完成的任务所对应的workInProgress节点，该节点即rootFiber.alternate属性所指向的节点
  finishedWork: Fiber | null,
  // Timeout handle returned by setTimeout. Used to cancel a pending timeout, if
  // it's superseded by a new one.
  // 表示通过setTimeout方法返回的句柄，用于将commit操作延迟到下一个事件循环
  // 这样当有新的任务进来时就可以通过该句柄来将之前的过程打断
  timeoutHandle: TimeoutHandle | NoTimeout,
  // Top context object, used by renderSubtreeIntoContainer
  context: Object | null,
  pendingContext: Object | null,
  // Determines if we should attempt to hydrate on the initial mount
  // 当前的fiberRoot是否处于hydrate模式
  +hydrate: boolean,
  // List of top-level batches. This list indicates whether a commit should be
  // deferred. Also contains completion callbacks.
  // TODO: Lift this into the renderer
  firstBatch: Batch | null,
  // Node returned by Scheduler.scheduleCallback
  // 每个fiberRoot实例上都只会维护一个任务，该任务保存在callbackNode属性中
  callbackNode: *,
  // Expiration of the callback associated with this root
  // 当前任务的过期时间
  callbackExpirationTime: ExpirationTime,
  // Priority of the callback associated with this root
  // 当前任务的优先级
  callbackPriority: ReactPriorityLevel,
  // The earliest pending expiration time that exists in the tree
  // 在树中存在的最早的挂起时间
  firstPendingTime: ExpirationTime,
  // The earliest suspended expiration time that exists in the tree
  // 在树中存在的最早的延迟时间
  firstSuspendedTime: ExpirationTime,
  // The latest suspended expiration time that exists in the tree
  // 在树中存在的最晚的延迟时间
  lastSuspendedTime: ExpirationTime,
  // The next known expiration time after the suspended range
  // 获取下一个已知的挂起等级
  nextKnownPendingLevel: ExpirationTime,
  // The latest time at which a suspended component pinged the root to
  // render again
  // 一个延迟组件应该通知fiber Root重新渲染的最晚时间
  lastPingedTime: ExpirationTime,
  // 表示最晚的过期时间
  lastExpiredTime: ExpirationTime,
|};

// The following attributes are only used by interaction tracing builds.
// They enable interactions to be associated with their async work,
// And expose interaction metadata to the React DevTools Profiler plugin.
// Note that these attributes are only defined when the enableSchedulerTracing flag is enabled.
type ProfilingOnlyFiberRootProperties = {|
  interactionThreadID: number,
  memoizedInteractions: Set<Interaction>,
  pendingInteractionMap: PendingInteractionMap,
|};

// The follow fields are only used by enableSuspenseCallback for hydration.
type SuspenseCallbackOnlyFiberRootProperties = {|
  hydrationCallbacks: null | SuspenseHydrationCallbacks,
|};

// Exported FiberRoot type includes all properties,
// To avoid requiring potentially error-prone :any casts throughout the project.
// Profiling properties are only safe to access in profiling builds (when enableSchedulerTracing is true).
// The types are defined separately within this file to ensure they stay in sync.
// (We don't have to use an inline :any cast when enableSchedulerTracing is disabled.)
export type FiberRoot = {
  ...BaseFiberRootProperties,
  ...ProfilingOnlyFiberRootProperties,
  ...SuspenseCallbackOnlyFiberRootProperties,
};

/**
 *  FiberRootNode构造函数(属性的相关注释信息已经写在上面的BaseFiberRootProperties中)
 * @param containerInfo DOM容器
 * @param tag fiberRoot节点的标记(LegacyRoot、BatchedRoot、ConcurrentRoot)
 * @param hydrate 判断是否是hydrate模式
 * @constructor
 */
function FiberRootNode(containerInfo, tag, hydrate) {
  this.tag = tag;
  this.current = null;
  this.containerInfo = containerInfo;
  this.pendingChildren = null;
  this.pingCache = null;
  this.finishedExpirationTime = NoWork;
  this.finishedWork = null;
  this.timeoutHandle = noTimeout;
  this.context = null;
  this.pendingContext = null;
  this.hydrate = hydrate;
  this.firstBatch = null;
  this.callbackNode = null;
  this.callbackPriority = NoPriority;
  this.firstPendingTime = NoWork;
  this.firstSuspendedTime = NoWork;
  this.lastSuspendedTime = NoWork;
  this.nextKnownPendingLevel = NoWork;
  this.lastPingedTime = NoWork;
  this.lastExpiredTime = NoWork;

  if (enableSchedulerTracing) {
    this.interactionThreadID = unstable_getThreadID();
    this.memoizedInteractions = new Set();
    this.pendingInteractionMap = new Map();
  }
  if (enableSuspenseCallback) {
    this.hydrationCallbacks = null;
  }
}

/**
 * 创建fiberRoot和rootFiber并相互引用
 * @param containerInfo DOM容器
 * @param tag fiberRoot节点的标记(LegacyRoot、BatchedRoot、ConcurrentRoot)
 * @param hydrate 判断是否是hydrate模式
 * @param hydrationCallbacks 只有在hydrate模式时才可能有值，该对象包含两个可选的方法：onHydrated和onDeleted
 * @returns {FiberRoot}
 */
export function createFiberRoot(
  containerInfo: any,
  tag: RootTag,
  hydrate: boolean,
  hydrationCallbacks: null | SuspenseHydrationCallbacks,
): FiberRoot {
  // 通过FiberRootNode构造函数创建一个fiberRoot实例
  const root: FiberRoot = (new FiberRootNode(containerInfo, tag, hydrate): any);
  if (enableSuspenseCallback) {
    root.hydrationCallbacks = hydrationCallbacks;
  }

  // Cyclic construction. This cheats the type system right now because
  // stateNode is any.
  // 通过createHostRootFiber方法创建fiber tree的根节点，即rootFiber
  // 需要留意的是，fiber节点也会像DOM树结构一样形成一个fiber tree单链表树结构
  // 每个DOM节点或者组件都会生成一个与之对应的fiber节点
  // 在后续的调和(reconciliation)阶段起着至关重要的作用
  const uninitializedFiber = createHostRootFiber(tag);
  // 创建完rootFiber之后，会将fiberRoot实例的current属性指向刚创建的rootFiber
  root.current = uninitializedFiber;
  // 同时rootFiber的stateNode属性会指向fiberRoot实例，形成相互引用
  uninitializedFiber.stateNode = root;
  // 最后将创建的fiberRoot实例返回
  return root;
}

export function isRootSuspendedAtTime(
  root: FiberRoot,
  expirationTime: ExpirationTime,
): boolean {
  const firstSuspendedTime = root.firstSuspendedTime;
  const lastSuspendedTime = root.lastSuspendedTime;
  return (
    firstSuspendedTime !== NoWork &&
    (firstSuspendedTime >= expirationTime &&
      lastSuspendedTime <= expirationTime)
  );
}

export function markRootSuspendedAtTime(
  root: FiberRoot,
  expirationTime: ExpirationTime,
): void {
  const firstSuspendedTime = root.firstSuspendedTime;
  const lastSuspendedTime = root.lastSuspendedTime;
  if (firstSuspendedTime < expirationTime) {
    root.firstSuspendedTime = expirationTime;
  }
  if (lastSuspendedTime > expirationTime || firstSuspendedTime === NoWork) {
    root.lastSuspendedTime = expirationTime;
  }

  if (expirationTime <= root.lastPingedTime) {
    root.lastPingedTime = NoWork;
  }

  if (expirationTime <= root.lastExpiredTime) {
    root.lastExpiredTime = NoWork;
  }
}

export function markRootUpdatedAtTime(
  root: FiberRoot,
  expirationTime: ExpirationTime,
): void {
  // Update the range of pending times
  const firstPendingTime = root.firstPendingTime;
  if (expirationTime > firstPendingTime) {
    root.firstPendingTime = expirationTime;
  }

  // Update the range of suspended times. Treat everything lower priority or
  // equal to this update as unsuspended.
  const firstSuspendedTime = root.firstSuspendedTime;
  if (firstSuspendedTime !== NoWork) {
    if (expirationTime >= firstSuspendedTime) {
      // The entire suspended range is now unsuspended.
      root.firstSuspendedTime = root.lastSuspendedTime = root.nextKnownPendingLevel = NoWork;
    } else if (expirationTime >= root.lastSuspendedTime) {
      root.lastSuspendedTime = expirationTime + 1;
    }

    // This is a pending level. Check if it's higher priority than the next
    // known pending level.
    if (expirationTime > root.nextKnownPendingLevel) {
      root.nextKnownPendingLevel = expirationTime;
    }
  }
}

export function markRootFinishedAtTime(
  root: FiberRoot,
  finishedExpirationTime: ExpirationTime,
  remainingExpirationTime: ExpirationTime,
): void {
  // Update the range of pending times
  root.firstPendingTime = remainingExpirationTime;

  // Update the range of suspended times. Treat everything higher priority or
  // equal to this update as unsuspended.
  if (finishedExpirationTime <= root.lastSuspendedTime) {
    // The entire suspended range is now unsuspended.
    root.firstSuspendedTime = root.lastSuspendedTime = root.nextKnownPendingLevel = NoWork;
  } else if (finishedExpirationTime <= root.firstSuspendedTime) {
    // Part of the suspended range is now unsuspended. Narrow the range to
    // include everything between the unsuspended time (non-inclusive) and the
    // last suspended time.
    root.firstSuspendedTime = finishedExpirationTime - 1;
  }

  if (finishedExpirationTime <= root.lastPingedTime) {
    // Clear the pinged time
    root.lastPingedTime = NoWork;
  }

  if (finishedExpirationTime <= root.lastExpiredTime) {
    // Clear the expired time
    root.lastExpiredTime = NoWork;
  }
}

export function markRootExpiredAtTime(
  root: FiberRoot,
  expirationTime: ExpirationTime,
): void {
  const lastExpiredTime = root.lastExpiredTime;
  if (lastExpiredTime === NoWork || lastExpiredTime > expirationTime) {
    root.lastExpiredTime = expirationTime;
  }
}
