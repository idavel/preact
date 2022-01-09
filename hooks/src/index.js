import { options } from 'preact';
import { getParentContext } from '../../src/tree';
import { MODE_UNMOUNTING } from '../../src/constants';

/** @type {number} */
let currentIndex;

/** @type {import('./internal').Internal} */
let currentInternal;

/** @type {number} */
let currentHook = 0;

/** @type {number} */
let currentIdCounter;

/** @type {Array<import('./internal').Component>} */
let afterPaintEffects = [];

let oldBeforeDiff = options._diff;
let oldBeforeRender = options._render;
let oldAfterDiff = options.diffed;
let oldCommit = options._commit;
let oldBeforeUnmount = options.unmount;

const RAF_TIMEOUT = 100;
let prevRaf;

options._diff = (internal, vnode) => {
	currentInternal = null;
	if (oldBeforeDiff) oldBeforeDiff(internal, vnode);
};

options._render = internal => {
	if (oldBeforeRender) oldBeforeRender(internal);

	currentInternal = internal;
	currentIdCounter = 0;
	currentIndex = 0;

	if (currentInternal.data && currentInternal.data.__hooks) {
		currentInternal.data.__hooks._pendingEffects.forEach(invokeCleanup);
		currentInternal.data.__hooks._pendingEffects.forEach(invokeEffect);
		currentInternal.data.__hooks._pendingEffects = [];
	}
};

options.diffed = internal => {
	if (oldAfterDiff) oldAfterDiff(internal);

	if (
		internal.data &&
		internal.data.__hooks &&
		internal.data.__hooks._pendingEffects.length
	) {
		afterPaint(afterPaintEffects.push(internal));
	}
};

options._commit = (internal, commitQueue) => {
	commitQueue.some(internal => {
		try {
			internal._commitCallbacks.forEach(invokeCleanup);
			internal._commitCallbacks = internal._commitCallbacks.filter(cb =>
				cb._value ? invokeEffect(cb) : true
			);
		} catch (e) {
			commitQueue.some(i => {
				if (i._commitCallbacks) i._commitCallbacks = [];
			});
			commitQueue = [];
			options._catchError(e, internal);
		}
	});

	if (oldCommit) oldCommit(internal, commitQueue);
};

options.unmount = internal => {
	if (oldBeforeUnmount) oldBeforeUnmount(internal);

	if (internal.data && internal.data.__hooks) {
		let hasErrored;
		internal.data.__hooks._list.forEach(s => {
			try {
				invokeCleanup(s);
			} catch (e) {
				hasErrored = e;
			}
		});
		if (hasErrored) options._catchError(hasErrored, internal);
	}
};

/**
 * Get a hook's state from the currentComponent
 * @param {number} index The index of the hook to get
 * @param {number} type The index of the hook to get
 * @returns {any}
 */
function getHookState(index, type) {
	if (options._hook) {
		options._hook(currentInternal, index, currentHook || type);
	}
	currentHook = 0;

	// Largely inspired by:
	// * https://github.com/michael-klein/funcy.js/blob/f6be73468e6ec46b0ff5aa3cc4c9baf72a29025a/src/hooks/core_hooks.mjs
	// * https://github.com/michael-klein/funcy.js/blob/650beaa58c43c33a74820a3c98b3c7079cf2e333/src/renderer.mjs
	// Other implementations to look at:
	// * https://codesandbox.io/s/mnox05qp8
	const hooks =
		currentInternal.data.__hooks ||
		(currentInternal.data.__hooks = {
			_list: [],
			_pendingEffects: []
		});

	if (index >= hooks._list.length) {
		hooks._list.push({});
	}
	return hooks._list[index];
}

/**
 * @param {import('./index').StateUpdater<any>} [initialState]
 */
export function useState(initialState) {
	currentHook = 1;
	return useReducer(invokeOrReturn, initialState);
}

/**
 * @param {import('./index').Reducer<any, any>} reducer
 * @param {import('./index').StateUpdater<any>} initialState
 * @param {(initialState: any) => void} [init]
 * @returns {[ any, (state: any) => void ]}
 */
export function useReducer(reducer, initialState, init) {
	/** @type {import('./internal').ReducerHookState} */
	const hookState = getHookState(currentIndex++, 2);
	hookState._reducer = reducer;
	if (!hookState._internal) {
		hookState._value = [
			!init ? invokeOrReturn(undefined, initialState) : init(initialState),

			action => {
				const nextValue = hookState._reducer(hookState._value[0], action);
				if (hookState._value[0] !== nextValue) {
					hookState._value = [nextValue, hookState._value[1]];
					hookState._internal.rerender(hookState._internal);
				}
			}
		];

		hookState._internal = currentInternal;
	}

	return hookState._value;
}

/**
 * @param {import('./internal').Effect} callback
 * @param {any[]} args
 */
export function useEffect(callback, args) {
	/** @type {import('./internal').EffectHookState} */
	const state = getHookState(currentIndex++, 3);
	if (!options._skipEffects && argsChanged(state._args, args)) {
		state._value = callback;
		state._args = args;

		currentInternal.data.__hooks._pendingEffects.push(state);
	}
}

/**
 * @param {import('./internal').Effect} callback
 * @param {any[]} args
 */
export function useLayoutEffect(callback, args) {
	/** @type {import('./internal').EffectHookState} */
	const state = getHookState(currentIndex++, 4);
	if (!options._skipEffects && argsChanged(state._args, args)) {
		state._value = callback;
		state._args = args;

		if (currentInternal._commitCallbacks == null) {
			currentInternal._commitCallbacks = [];
		}
		currentInternal._commitCallbacks.push(state);
	}
}

export function useRef(initialValue) {
	currentHook = 5;
	return useMemo(() => ({ current: initialValue }), []);
}

/**
 * @param {object} ref
 * @param {() => object} createHandle
 * @param {any[]} args
 */
export function useImperativeHandle(ref, createHandle, args) {
	currentHook = 6;
	useLayoutEffect(
		() => {
			if (typeof ref == 'function') ref(createHandle());
			else if (ref) ref.current = createHandle();
		},
		args == null ? args : args.concat(ref)
	);
}

/**
 * @param {() => any} factory
 * @param {any[]} args
 */
export function useMemo(factory, args) {
	/** @type {import('./internal').MemoHookState} */
	const state = getHookState(currentIndex++, 7);
	if (argsChanged(state._args, args)) {
		state._value = factory();
		state._args = args;
		state._factory = factory;
	}

	return state._value;
}

/**
 * @param {() => void} callback
 * @param {any[]} args
 */
export function useCallback(callback, args) {
	currentHook = 8;
	return useMemo(() => callback, args);
}

/**
 * @param {import('./internal').PreactContext} context
 */
export function useContext(context) {
	const provider = getParentContext(currentInternal)[context._id];
	// We could skip this call here, but than we'd not call
	// `options._hook`. We need to do that in order to make
	// the devtools aware of this hook.
	/** @type {import('./internal').ContextHookState} */
	const state = getHookState(currentIndex++, 9);
	// The devtools needs access to the context object to
	// be able to pull of the default value when no provider
	// is present in the tree.
	state._context = context;
	if (!provider) return context._defaultValue;
	// This is probably not safe to convert to "!"
	if (state._value == null) {
		state._value = true;
		provider._subs.add(currentInternal);
	}
	return provider.props.value;
}

/**
 * Display a custom label for a custom hook for the devtools panel
 * @type {<T>(value: T, cb?: (value: T) => string | number) => void}
 */
export function useDebugValue(value, formatter) {
	if (options.useDebugValue) {
		options.useDebugValue(formatter ? formatter(value) : value);
	}
}

const oldCatchError = options._catchError;
// TODO: this double traverses now in combination with the root _catchError
// however when we split Component up this shouldn't be needed
// there can be a better solution to this if we just do a single iteration
// as a combination of suspsense + hooks + component (compat) would be 3 tree-iterations
options._catchError = function(error, internal) {
	/** @type {import('./internal').Component} */
	let handler = internal;
	for (; (handler = handler._parent); ) {
		if (handler.data && handler.data._catchError) {
			return handler.data._catchError(error, internal);
		}
	}

	oldCatchError(error, internal);
};

/**
 * @param {(error: any) => void} cb
 */
export function useErrorBoundary(cb) {
	/** @type {import('./internal').ErrorBoundaryHookState} */
	const state = getHookState(currentIndex++, 10);
	const errState = useState();
	state._value = cb;

	if (!currentInternal.data._catchError) {
		currentInternal.data._catchError = err => {
			if (state._value) state._value(err);
			errState[1](err);
		};
	}
	return [
		errState[0],
		() => {
			errState[1](undefined);
		}
	];
}


export function useId() {
	const state = getHookState(currentIndex++, 11);
	if (!state._id) {
		currentIdCounter++;
		state._id = '' + currentInternal._depth + currentIdCounter
	}
	return state._id;
}

/**
 * After paint effects consumer.
 */
function flushAfterPaintEffects() {
	let internal;
	afterPaintEffects.sort((a, b) => a._depth - b._depth);
	while ((internal = afterPaintEffects.pop())) {
		if (~internal.flags & MODE_UNMOUNTING) {
			try {
				internal.data.__hooks._pendingEffects.forEach(invokeCleanup);
				internal.data.__hooks._pendingEffects.forEach(invokeEffect);
				internal.data.__hooks._pendingEffects = [];
			} catch (e) {
				internal.data.__hooks._pendingEffects = [];
				options._catchError(e, internal);
			}
		}
	}
}

let HAS_RAF = typeof requestAnimationFrame == 'function';

/**
 * Schedule a callback to be invoked after the browser has a chance to paint a new frame.
 * Do this by combining requestAnimationFrame (rAF) + setTimeout to invoke a callback after
 * the next browser frame.
 *
 * Also, schedule a timeout in parallel to the the rAF to ensure the callback is invoked
 * even if RAF doesn't fire (for example if the browser tab is not visible)
 *
 * @param {() => void} callback
 */
function afterNextFrame(callback) {
	const done = () => {
		clearTimeout(timeout);
		if (HAS_RAF) cancelAnimationFrame(raf);
		setTimeout(callback);
	};
	const timeout = setTimeout(done, RAF_TIMEOUT);

	let raf;
	if (HAS_RAF) {
		raf = requestAnimationFrame(done);
	}
}

// Note: if someone used options.debounceRendering = requestAnimationFrame,
// then effects will ALWAYS run on the NEXT frame instead of the current one, incurring a ~16ms delay.
// Perhaps this is not such a big deal.
/**
 * Schedule afterPaintEffects flush after the browser paints
 * @param {number} newQueueLength
 */
function afterPaint(newQueueLength) {
	if (newQueueLength === 1 || prevRaf !== options.requestAnimationFrame) {
		prevRaf = options.requestAnimationFrame;
		(prevRaf || afterNextFrame)(flushAfterPaintEffects);
	}
}

/**
 * @param {import('./internal').EffectHookState} hook
 */
function invokeCleanup(hook) {
	// A hook cleanup can introduce a call to render which creates a new root, this will call options.vnode
	// and move the currentInternal away.
	const internal = currentInternal;
	let cleanup = hook._cleanup;
	if (typeof cleanup == 'function') {
		hook._cleanup = undefined;
		cleanup();
	}
	currentInternal = internal;
}

/**
 * Invoke a Hook's effect
 * @param {import('./internal').EffectHookState} hook
 */
function invokeEffect(hook) {
	// A hook call can introduce a call to render which creates a new root, this will call options.vnode
	// and move the currentInternal away.
	const internal = currentInternal;
	hook._cleanup = hook._value();
	currentInternal = internal;
}

/**
 * @param {any[]} oldArgs
 * @param {any[]} newArgs
 */
function argsChanged(oldArgs, newArgs) {
	return (
		!oldArgs ||
		oldArgs.length !== newArgs.length ||
		newArgs.some((arg, index) => arg !== oldArgs[index])
	);
}

function invokeOrReturn(arg, f) {
	return typeof f == 'function' ? f(arg) : f;
}
