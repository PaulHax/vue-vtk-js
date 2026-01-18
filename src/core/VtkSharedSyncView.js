import {
  ref,
  inject,
  provide,
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  watch,
} from "vue";

import { LocalView, enableResetCamera } from "./localview";
import { withSharedContext } from "./SharedContextMixin";

export default {
  props: {
    camera: {
      type: Object,
      default: null,
    },
    interactorEvents: {
      type: Array,
      default: () => ["EndAnimation"],
    },
    interactorSettings: {
      type: Array,
      default: () => [
        {
          button: 1,
          action: "Rotate",
        },
        {
          button: 2,
          action: "Pan",
        },
        {
          button: 3,
          action: "Zoom",
          scrollEnabled: true,
        },
        {
          button: 1,
          action: "Pan",
          alt: true,
        },
        {
          button: 1,
          action: "Zoom",
          control: true,
        },
        {
          button: 1,
          action: "Select",
          shift: true,
        },
        {
          button: 1,
          action: "Roll",
          alt: true,
          shift: true,
        },
      ],
    },
    wsClient: {
      type: Object,
    },
    contextName: {
      type: String,
      default: "LocalRenderingContext",
    },
    viewState: {
      // Only used at mount time
      type: Object,
    },
    boxSelection: {
      type: Boolean,
      default: false,
    },
    pickingModes: {
      type: Array,
      default: () => [],
    },
    resyncTrigger: {
      type: String,
      default: "vtk_request_resync",
    },
  },
  emits: [
    "resetCamera",
    "beforeSceneLoaded",
    "afterSceneLoaded",
    "viewStateChange",
    "onReady",
    "resize",
    "onImageCapture",
    //
    "BoxSelection",
    // picking
    "select",
    "hover",
    "click",
    // https://github.com/Kitware/vtk-js/blob/master/Sources/Rendering/Core/RenderWindowInteractor/index.js#L27-L67
    "StartAnimation",
    "Animation",
    "EndAnimation",
    "PointerEnter",
    "PointerLeave",
    "MouseEnter",
    "MouseLeave",
    "StartMouseMove",
    "MouseMove",
    "EndMouseMove",
    "LeftButtonPress",
    "LeftButtonRelease",
    "MiddleButtonPress",
    "MiddleButtonRelease",
    "RightButtonPress",
    "RightButtonRelease",
    "KeyPress",
    "KeyDown",
    "KeyUp",
    "StartMouseWheel",
    "MouseWheel",
    "EndMouseWheel",
    "StartPinch",
    "Pinch",
    "EndPinch",
    "StartPan",
    "Pan",
    "EndPan",
    "StartRotate",
    "Rotate",
    "EndRotate",
    "Button3D",
    "Move3D",
    "StartPointerLock",
    "EndPointerLock",
    "StartInteraction",
    "Interaction",
    "EndInteraction",
    "AnimationFrameRateUpdate",
  ],
  setup(props, { emit }) {
    const trame = inject("trame");
    const ready = ref(false);
    const vtkContainer = ref(null);
    let idChanged = false;

    const client = computed(() => {
      return props.wsClient || trame?.client;
    });

    // Come up with a getArray implementation
    let getArray = () => Promise.resolve(null);
    const session = client.value?.getConnection()?.getSession();
    if (session) {
      getArray = (hash, binary) =>
        session.call("viewport.geometry.array.get", [hash, binary]);
    }
    if (client.value.getRemote()?.SyncView?.getArray) {
      getArray = client.value.getRemote()?.SyncView?.getArray;
    }

    // Create VTK stuff (shared context-enabled)
    const ViewClass = withSharedContext(LocalView);
    const view = new ViewClass(
      props.contextName,
      props.pickingModes,
      getArray,
      props.interactorEvents,
      { emit, nextTick, ready }
    );
    view.updateStyle(props.interactorSettings, onBoxSelectChange);
    const { onEnter, onLeave, onKeyUp } = enableResetCamera(view);
    const resizeObserver = new ResizeObserver(() => view.resize());

    function onBoxSelectChange({ container, selection }) {
      if (props.pickingModes.includes("select")) {
        view.onBoxSelectChange({ selection });
        return;
      }
      if (!props.boxSelection || !container) {
        return;
      }
      // Share the selection with the rest of the world
      emit("BoxSelection", {
        selection,
        mode: "local",
        size: view.openglRenderWindow.getSize(),
        camera: view.getCamera(),
      });
    }

    watch(ready, (v) => {
      emit("onReady", v);
    });

    watch(
      () => props.interactorSettings,
      () => view.updateStyle(props.interactorSettings, onBoxSelectChange)
    );
    watch(
      () => props.pickingModes,
      () => {
        view.pickingModes = props.pickingModes;
      }
    );
    watch(
      () => props.viewState,
      ({ id }) => {
        if (id === idChanged) {
          idChanged = false;
          view.updateViewState(props.viewState);
        }
      }
    );

    let wsSubscription = null;

    // Helper to call resync trigger
    const requestResync = () => {
      if (props.resyncTrigger && trame?.trigger) {
        trame.trigger(props.resyncTrigger);
      }
    };

    onMounted(() => {
      const container = vtkContainer.value;
      view.setContainer(container);
      resizeObserver.observe(container);
      document.addEventListener("keyup", onKeyUp);

      // Set view ID from viewState prop if available (for backwards compat)
      if (props.viewState?.id) {
        view.rwId = props.viewState.id;
      }

      // Subscribe to delta updates first
      wsSubscription = client.value
        .getConnection()
        .getSession()
        .subscribe("trame.vtk.delta", ([deltaState]) => {
          // Accept state if no rwId set yet, or if it matches
          if (!view.rwId || deltaState.id === view.rwId) {
            if (!view.rwId) {
              view.rwId = deltaState.id;
            }
            view.updateViewState(deltaState);
          }
        });

      // Wire up visibility handler to request resync on wake
      view.setResyncCallback?.(requestResync);

      // Request initial state from server via resync trigger
      requestResync();
    });

    onBeforeUnmount(() => {
      view.beforeDelete();

      if (wsSubscription && client.value) {
        client.value.getConnection().getSession().unsubscribe(wsSubscription);
        wsSubscription = null;
      }

      document.removeEventListener("keyup", onKeyUp);
      // Stop size listening
      resizeObserver.disconnect();
    });

    provide("view", view);

    const captureImage = async (format = "image/png", opts = {}) => {
      const img = await view.captureImage(format, opts);
      const response = await fetch(img);
      const blob = await response.blob();
      emit("onImageCapture", blob);
      return blob;
    };
    const resetCamera = () => view.resetCamera();
    const getCamera = () => view.getCamera();
    const setCamera = (v) => view.setCamera(v);
    const setSynchronizedViewId = (v) => {
      idChanged = v;
      if (typeof props.viewState.id === "number") {
        idChanged = Number(idChanged);
      }
      view.setSynchronizedViewId(idChanged);
    };
    const resize = () => view.resize();
    const setSize = (width, height) => view.openglRenderWindow.setSize(width, height);
    const triggerRender = () => {
      if (view.renderer) {
        view.renderer.resetCameraClippingRange();
      }
      view.renderWindow.render();
    };
    const getOpenGLRenderWindow = () => view.openglRenderWindow;
    const getRenderWindow = () => view.renderWindow;
    const renderNow = () => {
      if (view.renderer) {
        view.renderer.resetCameraClippingRange();
      }
      view.renderWindow.render();
    };
    const initializeForSharedContext = (canvas, gl, options) =>
      view.initializeForSharedContext?.(canvas, gl, options);
    const renderShared = (options) => view.renderShared?.(options);
    const onRenderRequested = (callback) => view.onRenderRequested?.(callback);
    const setRepaintCallback = (callback) => view.setRepaintCallback?.(callback);
    const setResyncCallback = (callback) => view.setResyncCallback?.(callback);

    const { onClick, onMouseMove } = view;
    return {
      vtkContainer,
      onEnter,
      onLeave,
      onClick,
      onMouseMove,
      resetCamera,
      getCamera,
      setCamera,
      setSynchronizedViewId,
      resize,
      captureImage,
      setSize,
      triggerRender,
      getOpenGLRenderWindow,
      getRenderWindow,
      renderNow,
      initializeForSharedContext,
      renderShared,
      onRenderRequested,
      setRepaintCallback,
      setResyncCallback,
      requestResync,
    };
  },
  template: `
        <div
            style="position:relative;width:100%;height:100%;"
            @mouseenter="onEnter"
            @mouseleave="onLeave"
            @click="onClick"
            @mousemove="onMouseMove"
        >
            <div
              ref="vtkContainer"
              style="position:absolute;width:100%;height:100%;overflow:hidden;"
            />
            <slot style="display: none;"></slot>
        </div>
    `,
};
