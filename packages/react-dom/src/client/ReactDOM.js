/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactNodeList} from 'shared/ReactTypes';
import type {RootTag} from 'shared/ReactRootTags';
// TODO: This type is shared between the reconciler and ReactDOM, but will
// eventually be lifted out to the renderer.
import type {
  FiberRoot,
  Batch as FiberRootBatch,
} from 'react-reconciler/src/ReactFiberRoot';

import '../shared/checkReact';
import './ReactDOMClientInjection';

import {
  computeUniqueAsyncExpiration,
  findHostInstanceWithNoPortals,
  updateContainerAtExpirationTime,
  flushRoot,
  createContainer,
  updateContainer,
  batchedEventUpdates,
  batchedUpdates,
  unbatchedUpdates,
  discreteUpdates,
  flushDiscreteUpdates,
  flushSync,
  flushControlled,
  injectIntoDevTools,
  getPublicRootInstance,
  findHostInstance,
  findHostInstanceWithWarning,
  flushPassiveEffects,
  IsThisRendererActing,
  attemptSynchronousHydration,
} from 'react-reconciler/inline.dom';
import {createPortal as createPortalImpl} from 'shared/ReactPortal';
import {canUseDOM} from 'shared/ExecutionEnvironment';
import {setBatchingImplementation} from 'legacy-events/ReactGenericBatching';
import {
  setRestoreImplementation,
  enqueueStateRestore,
  restoreStateIfNeeded,
} from 'legacy-events/ReactControlledComponent';
import {injection as EventPluginHubInjection} from 'legacy-events/EventPluginHub';
import {runEventsInBatch} from 'legacy-events/EventBatching';
import {eventNameDispatchConfigs} from 'legacy-events/EventPluginRegistry';
import {
  accumulateTwoPhaseDispatches,
  accumulateDirectDispatches,
} from 'legacy-events/EventPropagators';
import {LegacyRoot, ConcurrentRoot, BatchedRoot} from 'shared/ReactRootTags';
import {has as hasInstance} from 'shared/ReactInstanceMap';
import ReactVersion from 'shared/ReactVersion';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import getComponentName from 'shared/getComponentName';
import invariant from 'shared/invariant';
import lowPriorityWarningWithoutStack from 'shared/lowPriorityWarningWithoutStack';
import warningWithoutStack from 'shared/warningWithoutStack';
import {enableStableConcurrentModeAPIs} from 'shared/ReactFeatureFlags';

import {
  getInstanceFromNode,
  getNodeFromInstance,
  getFiberCurrentPropsFromNode,
  getClosestInstanceFromNode,
  markContainerAsRoot,
} from './ReactDOMComponentTree';
import {restoreControlledState} from './ReactDOMComponent';
import {dispatchEvent} from '../events/ReactDOMEventListener';
import {setAttemptSynchronousHydration} from '../events/ReactDOMEventReplaying';
import {eagerlyTrapReplayableEvents} from '../events/ReactDOMEventReplaying';
import {
  ELEMENT_NODE,
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCUMENT_FRAGMENT_NODE,
} from '../shared/HTMLNodeType';
import {ROOT_ATTRIBUTE_NAME} from '../shared/DOMProperty';

setAttemptSynchronousHydration(attemptSynchronousHydration);

const ReactCurrentOwner = ReactSharedInternals.ReactCurrentOwner;

let topLevelUpdateWarnings;
let warnOnInvalidCallback;
let didWarnAboutUnstableCreatePortal = false;

if (__DEV__) {
  if (
    typeof Map !== 'function' ||
    // $FlowIssue Flow incorrectly thinks Map has no prototype
    Map.prototype == null ||
    typeof Map.prototype.forEach !== 'function' ||
    typeof Set !== 'function' ||
    // $FlowIssue Flow incorrectly thinks Set has no prototype
    Set.prototype == null ||
    typeof Set.prototype.clear !== 'function' ||
    typeof Set.prototype.forEach !== 'function'
  ) {
    warningWithoutStack(
      false,
      'React depends on Map and Set built-in types. Make sure that you load a ' +
        'polyfill in older browsers. https://fb.me/react-polyfills',
    );
  }

  topLevelUpdateWarnings = (container: DOMContainer) => {
    if (container._reactRootContainer && container.nodeType !== COMMENT_NODE) {
      const hostInstance = findHostInstanceWithNoPortals(
        container._reactRootContainer._internalRoot.current,
      );
      if (hostInstance) {
        warningWithoutStack(
          hostInstance.parentNode === container,
          'render(...): It looks like the React-rendered content of this ' +
            'container was removed without using React. This is not ' +
            'supported and will cause errors. Instead, call ' +
            'ReactDOM.unmountComponentAtNode to empty a container.',
        );
      }
    }

    const isRootRenderedBySomeReact = !!container._reactRootContainer;
    const rootEl = getReactRootElementInContainer(container);
    const hasNonRootReactChild = !!(rootEl && getInstanceFromNode(rootEl));

    warningWithoutStack(
      !hasNonRootReactChild || isRootRenderedBySomeReact,
      'render(...): Replacing React-rendered children with a new root ' +
        'component. If you intended to update the children of this node, ' +
        'you should instead have the existing children update their state ' +
        'and render the new components instead of calling ReactDOM.render.',
    );

    warningWithoutStack(
      container.nodeType !== ELEMENT_NODE ||
        !((container: any): Element).tagName ||
        ((container: any): Element).tagName.toUpperCase() !== 'BODY',
      'render(): Rendering components directly into document.body is ' +
        'discouraged, since its children are often manipulated by third-party ' +
        'scripts and browser extensions. This may lead to subtle ' +
        'reconciliation issues. Try rendering into a container element created ' +
        'for your app.',
    );
  };

  warnOnInvalidCallback = function(callback: mixed, callerName: string) {
    warningWithoutStack(
      callback === null || typeof callback === 'function',
      '%s(...): Expected the last optional `callback` argument to be a ' +
        'function. Instead received: %s.',
      callerName,
      callback,
    );
  };
}

setRestoreImplementation(restoreControlledState);

export type DOMContainer =
  | (Element & {
      _reactRootContainer: ?(_ReactRoot | _ReactSyncRoot),
      _reactHasBeenPassedToCreateRootDEV: ?boolean,
    })
  | (Document & {
      _reactRootContainer: ?(_ReactRoot | _ReactSyncRoot),
      _reactHasBeenPassedToCreateRootDEV: ?boolean,
    });

type Batch = FiberRootBatch & {
  render(children: ReactNodeList): Work,
  then(onComplete: () => mixed): void,
  commit(): void,

  // The ReactRoot constructor is hoisted but the prototype methods are not. If
  // we move ReactRoot to be above ReactBatch, the inverse error occurs.
  // $FlowFixMe Hoisting issue.
  _root: _ReactRoot | _ReactSyncRoot,
  _hasChildren: boolean,
  _children: ReactNodeList,

  _callbacks: Array<() => mixed> | null,
  _didComplete: boolean,
};

type _ReactSyncRoot = {
  render(children: ReactNodeList, callback: ?() => mixed): Work,
  unmount(callback: ?() => mixed): Work,

  _internalRoot: FiberRoot,
};

type _ReactRoot = _ReactSyncRoot & {
  createBatch(): Batch,
};

function ReactBatch(root: _ReactRoot | _ReactSyncRoot) {
  const expirationTime = computeUniqueAsyncExpiration();
  this._expirationTime = expirationTime;
  this._root = root;
  this._next = null;
  this._callbacks = null;
  this._didComplete = false;
  this._hasChildren = false;
  this._children = null;
  this._defer = true;
}
ReactBatch.prototype.render = function(children: ReactNodeList) {
  invariant(
    this._defer,
    'batch.render: Cannot render a batch that already committed.',
  );
  this._hasChildren = true;
  this._children = children;
  const internalRoot = this._root._internalRoot;
  const expirationTime = this._expirationTime;
  const work = new ReactWork();
  updateContainerAtExpirationTime(
    children,
    internalRoot,
    null,
    expirationTime,
    null,
    work._onCommit,
  );
  return work;
};
ReactBatch.prototype.then = function(onComplete: () => mixed) {
  if (this._didComplete) {
    onComplete();
    return;
  }
  let callbacks = this._callbacks;
  if (callbacks === null) {
    callbacks = this._callbacks = [];
  }
  callbacks.push(onComplete);
};
ReactBatch.prototype.commit = function() {
  const internalRoot = this._root._internalRoot;
  let firstBatch = internalRoot.firstBatch;
  invariant(
    this._defer && firstBatch !== null,
    'batch.commit: Cannot commit a batch multiple times.',
  );

  if (!this._hasChildren) {
    // This batch is empty. Return.
    this._next = null;
    this._defer = false;
    return;
  }

  let expirationTime = this._expirationTime;

  // Ensure this is the first batch in the list.
  if (firstBatch !== this) {
    // This batch is not the earliest batch. We need to move it to the front.
    // Update its expiration time to be the expiration time of the earliest
    // batch, so that we can flush it without flushing the other batches.
    if (this._hasChildren) {
      expirationTime = this._expirationTime = firstBatch._expirationTime;
      // Rendering this batch again ensures its children will be the final state
      // when we flush (updates are processed in insertion order: last
      // update wins).
      // TODO: This forces a restart. Should we print a warning?
      this.render(this._children);
    }

    // Remove the batch from the list.
    let previous = null;
    let batch = firstBatch;
    while (batch !== this) {
      previous = batch;
      batch = batch._next;
    }
    invariant(
      previous !== null,
      'batch.commit: Cannot commit a batch multiple times.',
    );
    previous._next = batch._next;

    // Add it to the front.
    this._next = firstBatch;
    firstBatch = internalRoot.firstBatch = this;
  }

  // Synchronously flush all the work up to this batch's expiration time.
  this._defer = false;
  flushRoot(internalRoot, expirationTime);

  // Pop the batch from the list.
  const next = this._next;
  this._next = null;
  firstBatch = internalRoot.firstBatch = next;

  // Append the next earliest batch's children to the update queue.
  if (firstBatch !== null && firstBatch._hasChildren) {
    firstBatch.render(firstBatch._children);
  }
};
ReactBatch.prototype._onComplete = function() {
  if (this._didComplete) {
    return;
  }
  this._didComplete = true;
  const callbacks = this._callbacks;
  if (callbacks === null) {
    return;
  }
  // TODO: Error handling.
  for (let i = 0; i < callbacks.length; i++) {
    const callback = callbacks[i];
    callback();
  }
};

type Work = {
  then(onCommit: () => mixed): void,
  _onCommit: () => void,
  _callbacks: Array<() => mixed> | null,
  _didCommit: boolean,
};

function ReactWork() {
  this._callbacks = null;
  this._didCommit = false;
  // TODO: Avoid need to bind by replacing callbacks in the update queue with
  // list of Work objects.
  this._onCommit = this._onCommit.bind(this);
}
ReactWork.prototype.then = function(onCommit: () => mixed): void {
  if (this._didCommit) {
    onCommit();
    return;
  }
  let callbacks = this._callbacks;
  if (callbacks === null) {
    callbacks = this._callbacks = [];
  }
  callbacks.push(onCommit);
};
ReactWork.prototype._onCommit = function(): void {
  if (this._didCommit) {
    return;
  }
  this._didCommit = true;
  const callbacks = this._callbacks;
  if (callbacks === null) {
    return;
  }
  // TODO: Error handling.
  for (let i = 0; i < callbacks.length; i++) {
    const callback = callbacks[i];
    invariant(
      typeof callback === 'function',
      'Invalid argument passed as callback. Expected a function. Instead ' +
        'received: %s',
      callback,
    );
    callback();
  }
};

/**
 * 创建并返回一个fiberRoot
 * @param container DOM容器
 * @param tag fiberRoot节点的标记(LegacyRoot、BatchedRoot、ConcurrentRoot)
 * @param options 配置信息，只有在hydrate时才有值，否则为undefined
 * @returns {*}
 */
function createRootImpl(
  container: DOMContainer,
  tag: RootTag,
  options: void | RootOptions,
) {
  // Tag is either LegacyRoot or Concurrent Root
  // 判断是否是hydrate模式
  const hydrate = options != null && options.hydrate === true;
  const hydrationCallbacks =
    (options != null && options.hydrationOptions) || null;

  // 创建一个fiberRoot
  const root = createContainer(container, tag, hydrate, hydrationCallbacks);
  // 给container附加一个内部属性用于指向fiberRoot的current属性对应的rootFiber节点
  markContainerAsRoot(root.current, container);
  if (hydrate && tag !== LegacyRoot) {
    const doc =
      container.nodeType === DOCUMENT_NODE
        ? container
        : container.ownerDocument;
    eagerlyTrapReplayableEvents(doc);
  }
  return root;
}

/**
 * ReactSyncRoot构造函数
 * @param container DOM容器
 * @param tag fiberRoot节点的标记(LegacyRoot、BatchedRoot、ConcurrentRoot)
 * @param options 配置信息，只有在hydrate时才有值，否则为undefined
 * @constructor
 */
function ReactSyncRoot(
  container: DOMContainer,
  tag: RootTag,
  options: void | RootOptions,
) {
  this._internalRoot = createRootImpl(container, tag, options);
}

function ReactRoot(container: DOMContainer, options: void | RootOptions) {
  this._internalRoot = createRootImpl(container, ConcurrentRoot, options);
}

ReactRoot.prototype.render = ReactSyncRoot.prototype.render = function(
  children: ReactNodeList,
  callback: ?() => mixed,
): Work {
  const root = this._internalRoot;
  const work = new ReactWork();
  callback = callback === undefined ? null : callback;
  if (__DEV__) {
    warnOnInvalidCallback(callback, 'render');
  }
  if (callback !== null) {
    work.then(callback);
  }
  updateContainer(children, root, null, work._onCommit);
  return work;
};

ReactRoot.prototype.unmount = ReactSyncRoot.prototype.unmount = function(
  callback: ?() => mixed,
): Work {
  const root = this._internalRoot;
  const work = new ReactWork();
  callback = callback === undefined ? null : callback;
  if (__DEV__) {
    warnOnInvalidCallback(callback, 'render');
  }
  if (callback !== null) {
    work.then(callback);
  }
  updateContainer(null, root, null, work._onCommit);
  return work;
};

// Sync roots cannot create batches. Only concurrent ones.
ReactRoot.prototype.createBatch = function(): Batch {
  const batch = new ReactBatch(this);
  const expirationTime = batch._expirationTime;

  const internalRoot = this._internalRoot;
  const firstBatch = internalRoot.firstBatch;
  if (firstBatch === null) {
    internalRoot.firstBatch = batch;
    batch._next = null;
  } else {
    // Insert sorted by expiration time then insertion order
    let insertAfter = null;
    let insertBefore = firstBatch;
    while (
      insertBefore !== null &&
      insertBefore._expirationTime >= expirationTime
    ) {
      insertAfter = insertBefore;
      insertBefore = insertBefore._next;
    }
    batch._next = insertBefore;
    if (insertAfter !== null) {
      insertAfter._next = batch;
    }
  }

  return batch;
};

/**
 * True if the supplied DOM node is a valid node element.
 *
 * @param {?DOMElement} node The candidate DOM node.
 * @return {boolean} True if the DOM is a valid DOM node.
 * @internal
 */
function isValidContainer(node) {
  return !!(
    node &&
    (node.nodeType === ELEMENT_NODE ||
      node.nodeType === DOCUMENT_NODE ||
      node.nodeType === DOCUMENT_FRAGMENT_NODE ||
      (node.nodeType === COMMENT_NODE &&
        node.nodeValue === ' react-mount-point-unstable '))
  );
}

/**
 * 根据container来获取DOM容器中的第一个子节点
 * @param container DOM容器
 * @returns {*}
 */
function getReactRootElementInContainer(container: any) {
  if (!container) {
    return null;
  }

  if (container.nodeType === DOCUMENT_NODE) {
    return container.documentElement;
  } else {
    return container.firstChild;
  }
}

/**
 * 根据nodeType和attribute判断是否需要融合
 * @param container DOM容器
 * @returns {boolean}
 */
function shouldHydrateDueToLegacyHeuristic(container) {
  const rootElement = getReactRootElementInContainer(container);
  return !!(
    rootElement &&
    rootElement.nodeType === ELEMENT_NODE &&
    rootElement.hasAttribute(ROOT_ATTRIBUTE_NAME)
  );
}

setBatchingImplementation(
  batchedUpdates,
  discreteUpdates,
  flushDiscreteUpdates,
  batchedEventUpdates,
);

let warnedAboutHydrateAPI = false;

/**
 * 创建并返回一个ReactSyncRoot实例
 * @param container ReactDOM.render()或者ReactDOM.hydrate()中的第二个参数，组件需要挂载的DOM容器
 * @param forceHydrate 是否需要强制融合，render方法传false，hydrate方法传true
 * @returns {ReactSyncRoot}
 */
function legacyCreateRootFromDOMContainer(
  container: DOMContainer,
  forceHydrate: boolean,
): _ReactSyncRoot {
  // 判断是否需要融合
  const shouldHydrate =
    forceHydrate || shouldHydrateDueToLegacyHeuristic(container);
  // First clear any existing content.
  // 针对客户端渲染的情况，需要将container容器中的所有元素移除
  if (!shouldHydrate) {
    let warned = false;
    let rootSibling;
    // 循环遍历每个子节点进行删除
    while ((rootSibling = container.lastChild)) {
      if (__DEV__) {
        if (
          !warned &&
          rootSibling.nodeType === ELEMENT_NODE &&
          (rootSibling: any).hasAttribute(ROOT_ATTRIBUTE_NAME)
        ) {
          warned = true;
          warningWithoutStack(
            false,
            'render(): Target node has markup rendered by React, but there ' +
              'are unrelated nodes as well. This is most commonly caused by ' +
              'white-space inserted around server-rendered markup.',
          );
        }
      }
      container.removeChild(rootSibling);
    }
  }
  if (__DEV__) {
    if (shouldHydrate && !forceHydrate && !warnedAboutHydrateAPI) {
      warnedAboutHydrateAPI = true;
      lowPriorityWarningWithoutStack(
        false,
        'render(): Calling ReactDOM.render() to hydrate server-rendered markup ' +
          'will stop working in React v17. Replace the ReactDOM.render() call ' +
          'with ReactDOM.hydrate() if you want React to attach to the server HTML.',
      );
    }
  }

  // Legacy roots are not batched.
  // 返回一个ReactSyncRoot实例
  // 该实例具有一个_internalRoot属性指向fiberRoot
  return new ReactSyncRoot(
    container,
    LegacyRoot,
    shouldHydrate
      ? {
          hydrate: true,
        }
      : undefined,
  );
}

/**
 * 开始构建FiberRoot和RootFiber，之后开始执行更新任务
 * @param parentComponent 父组件，可以把它当成null值来处理
 * @param children ReactDOM.render()或者ReactDOM.hydrate()中的第一个参数，可以理解为根组件
 * @param container ReactDOM.render()或者ReactDOM.hydrate()中的第二个参数，组件需要挂载的DOM容器
 * @param forceHydrate 表示是否融合，用于区分客户端渲染和服务端渲染，render方法传false，hydrate方法传true
 * @param callback ReactDOM.render()或者ReactDOM.hydrate()中的第三个参数，组件渲染完成后需要执行的回调函数
 * @returns {*}
 */
function legacyRenderSubtreeIntoContainer(
  parentComponent: ?React$Component<any, any>,
  children: ReactNodeList,
  container: DOMContainer,
  forceHydrate: boolean,
  callback: ?Function,
) {
  if (__DEV__) {
    topLevelUpdateWarnings(container);
    warnOnInvalidCallback(callback === undefined ? null : callback, 'render');
  }

  // TODO: Without `any` type, Flow says "Property cannot be accessed on any
  // member of intersection type." Whyyyyyy.
  // 在第一次执行的时候，container上是肯定没有_reactRootContainer属性的
  // 所以第一次执行时，root肯定为undefined
  let root: _ReactSyncRoot = (container._reactRootContainer: any);
  let fiberRoot;
  if (!root) {
    // Initial mount
    // 首次挂载，进入当前流程控制中，container._reactRootContainer指向一个ReactSyncRoot实例
    root = container._reactRootContainer = legacyCreateRootFromDOMContainer(
      container,
      forceHydrate,
    );
    // root表示一个ReactSyncRoot实例，实例中有一个_internalRoot方法指向一个fiberRoot实例
    fiberRoot = root._internalRoot;
    // callback表示ReactDOM.render()或者ReactDOM.hydrate()中的第三个参数
    // 重写callback，通过fiberRoot去找到其对应的rootFiber，然后将rootFiber的第一个child的stateNode作为callback中的this指向
    // 一般情况下我们很少去写第三个参数，所以可以不必关心这里的内容
    if (typeof callback === 'function') {
      const originalCallback = callback;
      callback = function() {
        const instance = getPublicRootInstance(fiberRoot);
        originalCallback.call(instance);
      };
    }
    // Initial mount should not be batched.
    // 对于首次挂载来说，更新操作不应该是批量的，所以会先执行unbatchedUpdates方法
    // 该方法中会将executionContext(执行上下文)切换成LegacyUnbatchedContext(非批量上下文)
    // 切换上下文之后再调用updateContainer执行更新操作
    // 执行完updateContainer之后再将executionContext恢复到之前的状态
    unbatchedUpdates(() => {
      updateContainer(children, fiberRoot, parentComponent, callback);
    });
  } else {
    // 不是首次挂载，即container._reactRootContainer上已经存在一个ReactSyncRoot实例
    fiberRoot = root._internalRoot;
    // 下面的控制语句和上面的逻辑保持一致
    if (typeof callback === 'function') {
      const originalCallback = callback;
      callback = function() {
        const instance = getPublicRootInstance(fiberRoot);
        originalCallback.call(instance);
      };
    }
    // Update
    // 对于非首次挂载来说，是不需要再调用unbatchedUpdates方法的
    // 即不再需要将executionContext(执行上下文)切换成LegacyUnbatchedContext(非批量上下文)
    // 而是直接调用updateContainer执行更新操作
    updateContainer(children, fiberRoot, parentComponent, callback);
  }
  return getPublicRootInstance(fiberRoot);
}

function createPortal(
  children: ReactNodeList,
  container: DOMContainer,
  key: ?string = null,
) {
  invariant(
    isValidContainer(container),
    'Target container is not a DOM element.',
  );
  // TODO: pass ReactDOM portal implementation as third argument
  return createPortalImpl(children, container, null, key);
}

const ReactDOM: Object = {
  createPortal,

  findDOMNode(
    componentOrElement: Element | ?React$Component<any, any>,
  ): null | Element | Text {
    if (__DEV__) {
      let owner = (ReactCurrentOwner.current: any);
      if (owner !== null && owner.stateNode !== null) {
        const warnedAboutRefsInRender =
          owner.stateNode._warnedAboutRefsInRender;
        warningWithoutStack(
          warnedAboutRefsInRender,
          '%s is accessing findDOMNode inside its render(). ' +
            'render() should be a pure function of props and state. It should ' +
            'never access something that requires stale data from the previous ' +
            'render, such as refs. Move this logic to componentDidMount and ' +
            'componentDidUpdate instead.',
          getComponentName(owner.type) || 'A component',
        );
        owner.stateNode._warnedAboutRefsInRender = true;
      }
    }
    if (componentOrElement == null) {
      return null;
    }
    if ((componentOrElement: any).nodeType === ELEMENT_NODE) {
      return (componentOrElement: any);
    }
    if (__DEV__) {
      return findHostInstanceWithWarning(componentOrElement, 'findDOMNode');
    }
    return findHostInstance(componentOrElement);
  },

  /**
   * 服务端渲染
   * @param element 表示一个ReactNode，可以是一个ReactElement对象
   * @param container 需要将组件挂载到页面中的DOM容器
   * @param callback 渲染完成后需要执行的回调函数
   */
  hydrate(element: React$Node, container: DOMContainer, callback: ?Function) {
    invariant(
      isValidContainer(container),
      'Target container is not a DOM element.',
    );
    if (__DEV__) {
      warningWithoutStack(
        !container._reactHasBeenPassedToCreateRootDEV,
        'You are calling ReactDOM.hydrate() on a container that was previously ' +
          'passed to ReactDOM.%s(). This is not supported. ' +
          'Did you mean to call createRoot(container, {hydrate: true}).render(element)?',
        enableStableConcurrentModeAPIs ? 'createRoot' : 'unstable_createRoot',
      );
    }
    // TODO: throw or warn if we couldn't hydrate?
    // 注意第一个参数为null，第四个参数为true
    return legacyRenderSubtreeIntoContainer(
      null,
      element,
      container,
      true,
      callback,
    );
  },

  /**
   * 客户端渲染
   * @param element 表示一个ReactElement对象
   * @param container 需要将组件挂载到页面中的DOM容器
   * @param callback 渲染完成后需要执行的回调函数
   */
  render(
    element: React$Element<any>,
    container: DOMContainer,
    callback: ?Function,
  ) {
    invariant(
      isValidContainer(container),
      'Target container is not a DOM element.',
    );
    if (__DEV__) {
      warningWithoutStack(
        !container._reactHasBeenPassedToCreateRootDEV,
        'You are calling ReactDOM.render() on a container that was previously ' +
          'passed to ReactDOM.%s(). This is not supported. ' +
          'Did you mean to call root.render(element)?',
        enableStableConcurrentModeAPIs ? 'createRoot' : 'unstable_createRoot',
      );
    }
    // 注意第一个参数为null，第四个参数为false
    return legacyRenderSubtreeIntoContainer(
      null,
      element,
      container,
      false,
      callback,
    );
  },

  unstable_renderSubtreeIntoContainer(
    parentComponent: React$Component<any, any>,
    element: React$Element<any>,
    containerNode: DOMContainer,
    callback: ?Function,
  ) {
    invariant(
      isValidContainer(containerNode),
      'Target container is not a DOM element.',
    );
    invariant(
      parentComponent != null && hasInstance(parentComponent),
      'parentComponent must be a valid React Component',
    );
    return legacyRenderSubtreeIntoContainer(
      parentComponent,
      element,
      containerNode,
      false,
      callback,
    );
  },

  unmountComponentAtNode(container: DOMContainer) {
    invariant(
      isValidContainer(container),
      'unmountComponentAtNode(...): Target container is not a DOM element.',
    );

    if (__DEV__) {
      warningWithoutStack(
        !container._reactHasBeenPassedToCreateRootDEV,
        'You are calling ReactDOM.unmountComponentAtNode() on a container that was previously ' +
          'passed to ReactDOM.%s(). This is not supported. Did you mean to call root.unmount()?',
        enableStableConcurrentModeAPIs ? 'createRoot' : 'unstable_createRoot',
      );
    }

    if (container._reactRootContainer) {
      if (__DEV__) {
        const rootEl = getReactRootElementInContainer(container);
        const renderedByDifferentReact = rootEl && !getInstanceFromNode(rootEl);
        warningWithoutStack(
          !renderedByDifferentReact,
          "unmountComponentAtNode(): The node you're attempting to unmount " +
            'was rendered by another copy of React.',
        );
      }

      // Unmount should not be batched.
      unbatchedUpdates(() => {
        legacyRenderSubtreeIntoContainer(null, null, container, false, () => {
          container._reactRootContainer = null;
        });
      });
      // If you call unmountComponentAtNode twice in quick succession, you'll
      // get `true` twice. That's probably fine?
      return true;
    } else {
      if (__DEV__) {
        const rootEl = getReactRootElementInContainer(container);
        const hasNonRootReactChild = !!(rootEl && getInstanceFromNode(rootEl));

        // Check if the container itself is a React root node.
        const isContainerReactRoot =
          container.nodeType === ELEMENT_NODE &&
          isValidContainer(container.parentNode) &&
          !!container.parentNode._reactRootContainer;

        warningWithoutStack(
          !hasNonRootReactChild,
          "unmountComponentAtNode(): The node you're attempting to unmount " +
            'was rendered by React and is not a top-level container. %s',
          isContainerReactRoot
            ? 'You may have accidentally passed in a React root node instead ' +
              'of its container.'
            : 'Instead, have the parent component update its state and ' +
              'rerender in order to remove this component.',
        );
      }

      return false;
    }
  },

  // Temporary alias since we already shipped React 16 RC with it.
  // TODO: remove in React 17.
  unstable_createPortal(...args) {
    if (!didWarnAboutUnstableCreatePortal) {
      didWarnAboutUnstableCreatePortal = true;
      lowPriorityWarningWithoutStack(
        false,
        'The ReactDOM.unstable_createPortal() alias has been deprecated, ' +
          'and will be removed in React 17+. Update your code to use ' +
          'ReactDOM.createPortal() instead. It has the exact same API, ' +
          'but without the "unstable_" prefix.',
      );
    }
    return createPortal(...args);
  },

  unstable_batchedUpdates: batchedUpdates,

  // TODO remove this legacy method, unstable_discreteUpdates replaces it
  unstable_interactiveUpdates: (fn, a, b, c) => {
    flushDiscreteUpdates();
    return discreteUpdates(fn, a, b, c);
  },

  unstable_discreteUpdates: discreteUpdates,
  unstable_flushDiscreteUpdates: flushDiscreteUpdates,

  flushSync: flushSync,

  unstable_createRoot: createRoot,
  unstable_createSyncRoot: createSyncRoot,
  unstable_flushControlled: flushControlled,

  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
    // Keep in sync with ReactDOMUnstableNativeDependencies.js
    // ReactTestUtils.js, and ReactTestUtilsAct.js. This is an array for better minification.
    Events: [
      getInstanceFromNode,
      getNodeFromInstance,
      getFiberCurrentPropsFromNode,
      EventPluginHubInjection.injectEventPluginsByName,
      eventNameDispatchConfigs,
      accumulateTwoPhaseDispatches,
      accumulateDirectDispatches,
      enqueueStateRestore,
      restoreStateIfNeeded,
      dispatchEvent,
      runEventsInBatch,
      flushPassiveEffects,
      IsThisRendererActing,
    ],
  },
};

type RootOptions = {
  hydrate?: boolean,
  hydrationOptions?: {
    onHydrated?: (suspenseNode: Comment) => void,
    onDeleted?: (suspenseNode: Comment) => void,
  },
};

function createRoot(
  container: DOMContainer,
  options?: RootOptions,
): _ReactRoot {
  const functionName = enableStableConcurrentModeAPIs
    ? 'createRoot'
    : 'unstable_createRoot';
  invariant(
    isValidContainer(container),
    '%s(...): Target container is not a DOM element.',
    functionName,
  );
  warnIfReactDOMContainerInDEV(container);
  return new ReactRoot(container, options);
}

function createSyncRoot(
  container: DOMContainer,
  options?: RootOptions,
): _ReactSyncRoot {
  const functionName = enableStableConcurrentModeAPIs
    ? 'createRoot'
    : 'unstable_createRoot';
  invariant(
    isValidContainer(container),
    '%s(...): Target container is not a DOM element.',
    functionName,
  );
  warnIfReactDOMContainerInDEV(container);
  return new ReactSyncRoot(container, BatchedRoot, options);
}

function warnIfReactDOMContainerInDEV(container) {
  if (__DEV__) {
    warningWithoutStack(
      !container._reactRootContainer,
      'You are calling ReactDOM.%s() on a container that was previously ' +
        'passed to ReactDOM.render(). This is not supported.',
      enableStableConcurrentModeAPIs ? 'createRoot' : 'unstable_createRoot',
    );
    container._reactHasBeenPassedToCreateRootDEV = true;
  }
}

if (enableStableConcurrentModeAPIs) {
  ReactDOM.createRoot = createRoot;
  ReactDOM.createSyncRoot = createSyncRoot;
}

const foundDevTools = injectIntoDevTools({
  findFiberByHostInstance: getClosestInstanceFromNode,
  bundleType: __DEV__ ? 1 : 0,
  version: ReactVersion,
  rendererPackageName: 'react-dom',
});

if (__DEV__) {
  if (!foundDevTools && canUseDOM && window.top === window.self) {
    // If we're in Chrome or Firefox, provide a download link if not installed.
    if (
      (navigator.userAgent.indexOf('Chrome') > -1 &&
        navigator.userAgent.indexOf('Edge') === -1) ||
      navigator.userAgent.indexOf('Firefox') > -1
    ) {
      const protocol = window.location.protocol;
      // Don't warn in exotic cases like chrome-extension://.
      if (/^(https?|file):$/.test(protocol)) {
        console.info(
          '%cDownload the React DevTools ' +
            'for a better development experience: ' +
            'https://fb.me/react-devtools' +
            (protocol === 'file:'
              ? '\nYou might need to use a local HTTP server (instead of file://): ' +
                'https://fb.me/react-devtools-faq'
              : ''),
          'font-weight:bold',
        );
      }
    }
  }
}

export default ReactDOM;
