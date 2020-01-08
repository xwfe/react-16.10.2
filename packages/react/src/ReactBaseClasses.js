/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import invariant from 'shared/invariant';
import lowPriorityWarningWithoutStack from 'shared/lowPriorityWarningWithoutStack';

import ReactNoopUpdateQueue from './ReactNoopUpdateQueue';

const emptyObject = {};
if (__DEV__) {
  Object.freeze(emptyObject);
}

/**
 * Base class helpers for the updating state of a component.
 */

/**
 * 构造函数，用于创建一个类组件的实例
 * @param props 表示所拥有的属性信息
 * @param context 表示所处的上下文信息
 * @param updater 表示一个updater对象，这个对象非常重要，用于处理后续的更新调度任务
 */
function Component(props, context, updater) {
  this.props = props;
  this.context = context;
  // If a component has string refs, we will assign a different object later.
  // 该属性用于存储类组件实例的引用信息
  // 在React中我们可以有多种方式来创建引用
  // 通过字符串的方式，如：<input type="text" ref="inputRef" />
  // 通过回调函数的方式，如：<input type="text" ref={(input) => this.inputRef = input;} />
  // 通过React.createRef()的方式，如：this.inputRef = React.createRef(null); <input type="text" ref={this.inputRef} />
  // 通过useRef()的方式，如：this.inputRef = useRef(null); <input type="text" ref={this.inputRef} />
  this.refs = emptyObject;
  // We initialize the default updater but the real one gets injected by the
  // renderer.
  // 当state发生变化的时候，需要updater对象去处理后续的更新调度任务
  this.updater = updater || ReactNoopUpdateQueue;
}

// 在原型上新增了一个isReactComponent属性用于标识该实例是一个类组件的实例
// 这个地方曾经有面试官考过，问如何区分函数定义组件和类组件
// 函数定义组件是没有这个属性的，所以可以通过判断原型上是否拥有这个属性来进行区分
Component.prototype.isReactComponent = {};

/**
 * Sets a subset of the state. Always use this to mutate
 * state. You should treat `this.state` as immutable.
 *
 * There is no guarantee that `this.state` will be immediately updated, so
 * accessing `this.state` after calling this method may return the old value.
 *
 * There is no guarantee that calls to `setState` will run synchronously,
 * as they may eventually be batched together.  You can provide an optional
 * callback that will be executed when the call to setState is actually
 * completed.
 *
 * When a function is provided to setState, it will be called at some point in
 * the future (not synchronously). It will be called with the up to date
 * component arguments (state, props, context). These values can be different
 * from this.* because your function may be called after receiveProps but before
 * shouldComponentUpdate, and this new state, props, and context will not yet be
 * assigned to this.
 *
 * @param {object|function} partialState Next partial state or function to
 *        produce next partial state to be merged with current state.
 * @param {?function} callback Called after state is updated.
 * @final
 * @protected
 */

/**
 * 用于更新状态
 * @param partialState 表示下次需要更新的状态
 * @param callback 在组件更新之后需要执行的回调
 */
Component.prototype.setState = function(partialState, callback) {
  invariant(
    typeof partialState === 'object' ||
      typeof partialState === 'function' ||
      partialState == null,
    'setState(...): takes an object of state variables to update or a ' +
      'function which returns an object of state variables.',
  );
  this.updater.enqueueSetState(this, partialState, callback, 'setState');
};

/**
 * Forces an update. This should only be invoked when it is known with
 * certainty that we are **not** in a DOM transaction.
 *
 * You may want to call this when you know that some deeper aspect of the
 * component's state has changed but `setState` was not called.
 *
 * This will not invoke `shouldComponentUpdate`, but it will invoke
 * `componentWillUpdate` and `componentDidUpdate`.
 *
 * @param {?function} callback Called after update is complete.
 * @final
 * @protected
 */

/**
 * 用于强制重新渲染
 * @param callback 在组件重新渲染之后需要执行的回调
 */
Component.prototype.forceUpdate = function(callback) {
  this.updater.enqueueForceUpdate(this, callback, 'forceUpdate');
};

/**
 * Deprecated APIs. These APIs used to exist on classic React classes but since
 * we would like to deprecate them, we're not going to move them over to this
 * modern base class. Instead, we define a getter that warns if it's accessed.
 */
if (__DEV__) {
  const deprecatedAPIs = {
    isMounted: [
      'isMounted',
      'Instead, make sure to clean up subscriptions and pending requests in ' +
        'componentWillUnmount to prevent memory leaks.',
    ],
    replaceState: [
      'replaceState',
      'Refactor your code to use setState instead (see ' +
        'https://github.com/facebook/react/issues/3236).',
    ],
  };
  const defineDeprecationWarning = function(methodName, info) {
    Object.defineProperty(Component.prototype, methodName, {
      get: function() {
        lowPriorityWarningWithoutStack(
          false,
          '%s(...) is deprecated in plain JavaScript React classes. %s',
          info[0],
          info[1],
        );
        return undefined;
      },
    });
  };
  for (const fnName in deprecatedAPIs) {
    if (deprecatedAPIs.hasOwnProperty(fnName)) {
      defineDeprecationWarning(fnName, deprecatedAPIs[fnName]);
    }
  }
}

// 通过借用构造函数，实现典型的寄生组合式继承，避免原型污染
function ComponentDummy() {}
ComponentDummy.prototype = Component.prototype;

/**
 * Convenience component with default shallow equality check for sCU.
 */
function PureComponent(props, context, updater) {
  this.props = props;
  this.context = context;
  // If a component has string refs, we will assign a different object later.
  this.refs = emptyObject;
  this.updater = updater || ReactNoopUpdateQueue;
}

// 将PureComponent的原型指向借用构造函数的实例
const pureComponentPrototype = (PureComponent.prototype = new ComponentDummy());

// 重新设置构造函数的指向
pureComponentPrototype.constructor = PureComponent;

// Avoid an extra prototype jump for these methods.
// 将Component.prototype和PureComponent.prototype进行合并，减少原型链查找所浪费的时间(原型链越长所耗费的时间越久)
Object.assign(pureComponentPrototype, Component.prototype);

// 这里是与Component的区别之处，PureComponent的原型上拥有一个isPureReactComponent属性
pureComponentPrototype.isPureReactComponent = true;

export {Component, PureComponent};
