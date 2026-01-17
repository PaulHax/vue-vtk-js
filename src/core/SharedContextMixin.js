import vtkSharedRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/SharedRenderWindow";
import { allArraysHaveInlineData } from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/SyncExtension/validation";
import { updateRenderWindowSync } from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/SyncExtension/syncUpdaters";
import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";

export function withSharedContext(BaseView) {
  return class SharedContextView extends BaseView {
    initializeForSharedContext(canvas, gl, options = {}) {
      try {
        this._sharedContext = true;
      // Render gating flag: true only while we are actively applying state.
      // (Host render loops like MapLibre can safely render between batches.)
      this._sharedUpdateInProgress = false;
      // Runner lock: prevents concurrent queue drainers.
      this._sharedUpdateRunnerActive = false;
      this._sharedUpdateQueue = [];

      // Cache for array content: hash -> TypedArray
      // Used to inject cached content into states missing inline data
      this._arrayContentCache = new Map();

      // Sync-at-render mode (deck.gl style): queue state, apply at render time
      this._syncStateAtRender = false;
      this._requestRepaintCallback = null;

      const {
        // Deck.gl-style sync: queue state when it arrives, apply synchronously at render.
        // Eliminates flicker by making state application atomic with rendering.
        // Requires host to call triggerRepaint when state arrives.
        syncStateAtRender = false,
        ...contextOptions
      } = options || {};
      this._syncStateAtRender = !!syncStateAtRender;

      // Replace openglRenderWindow with SharedRenderWindow
      this.renderWindow.removeView(this.openglRenderWindow);
      this.openglRenderWindow.delete();
      this.openglRenderWindow = vtkSharedRenderWindow.createFromContext(
        canvas,
        gl,
        contextOptions
      );
      this.renderWindow.addView(this.openglRenderWindow);
      this.interactor.setView(this.openglRenderWindow);

      if (this.selector) {
        this.selector.attach(this.openglRenderWindow, this.renderer);
      }

      if (this._renderRequestedCallback) {
        if (this.openglRenderWindow?.setRenderCallback) {
          this.openglRenderWindow.setRenderCallback(this._renderRequestedCallback);
        }
      }

      // Intercept cacheArray to track cached hashes for later injection
      const originalCacheArray = this.ctx.cacheArray?.bind(this.ctx);
      if (originalCacheArray) {
        this.ctx.cacheArray = (sha, array, context) => {
          originalCacheArray(sha, array, context);
          if (!this._arrayContentCache.has(sha)) {
            this._arrayContentCache.set(sha, array);
          }
        };
      }
      } catch (e) {
        console.error('[SharedContext] Initialization error:', e, e?.message, e?.stack);
        throw e;
      }
    }

    // Utility methods that use the imported functions
    hasInlineData(state) {
      return allArraysHaveInlineData(state);
    }

    _typedArrayToBase64(typedArray) {
      const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }

    _injectCachedContent(state) {
      if (!this._arrayContentCache?.size) return;

      const walkObj = (obj) => {
        if (!obj || typeof obj !== 'object') return;

        // Check if this is an array descriptor missing content
        if (obj.hash && obj.dataType && !obj.content) {
          const cachedArray = this._arrayContentCache.get(obj.hash);
          if (cachedArray) {
            obj.content = this._typedArrayToBase64(cachedArray);
          }
        }

        // Recurse into nested structures
        if (obj.properties) {
          Object.values(obj.properties).forEach(walkObj);
        }
        if (obj.dependencies) {
          obj.dependencies.forEach(walkObj);
        }
        if (obj.arrays) {
          Object.values(obj.arrays).forEach(walkObj);
        }
        if (Array.isArray(obj)) {
          obj.forEach(walkObj);
        }
      };
      walkObj(state);
    }

    _synchronizeStateSync(state, skipRender = false) {
      try {
        const context = this.ctx;
        if (!context) {
          console.error('[SharedContext] _synchronizeStateSync: context is undefined');
          return false;
        }

        updateRenderWindowSync(
          this.renderWindow,
          state,
          context,
          vtkObjectManager
        );

        if (!skipRender) {
          this.renderWindow.render();
        }

        return true;
      } catch (e) {
        console.error('[SharedContext] _synchronizeStateSync error:', e, e?.message, e?.stack);
        throw e;
      }
    }

    setRepaintCallback(callback) {
      this._requestRepaintCallback = callback;
    }

    async updateViewState(remoteState) {
      if (!this._sharedUpdateQueue) {
        this._sharedUpdateQueue = [];
      }
      this._sharedUpdateQueue.push(remoteState);

      // Sync-at-render mode (deck.gl style): just queue state, apply at render time
      if (this._syncStateAtRender) {
        if (this._requestRepaintCallback) {
          this._requestRepaintCallback();
        }
        return;
      }

      if (this._sharedUpdateRunnerActive) {
        return;
      }

      this._sharedUpdateRunnerActive = true;
      this._sharedUpdateInProgress = true;
      this._setInteractorRenderEnabled(false);
      this.busy.reset();
      this.busy.start();

      try {
        const raf =
          typeof requestAnimationFrame === "function"
            ? requestAnimationFrame
            : (cb) => setTimeout(cb, 0);
        while (this._sharedUpdateQueue.length) {
          const nextState = this._sharedUpdateQueue.shift();

          this.vueCtx.emit("beforeSceneLoaded");

          // Force to process provided state
          this.mtime = Math.max(this.mtime, nextState.mtime) + 1;
          nextState.mtime = this.mtime;
          const progress = this.renderWindow.synchronize(nextState);

          // Bind camera as soon as possible
          if (progress) {
            if (this.renderWindow.getRenderersByReference().length) {
              [this.renderer] = this.renderWindow.getRenderersByReference();
              this.activeCamera = this.renderer.getActiveCamera();
            }
            if (
              nextState.extra &&
              nextState.extra.camera &&
              this.activeCamera
            ) {
              this.ctx.registerInstance(
                nextState.extra.camera,
                this.activeCamera
              );
            }
          }

          const success = await progress;
          if (success && nextState.extra) {
            if (nextState.extra.camera) {
              this.remoteCamera = this.ctx.getInstance(
                nextState.extra.camera
              );
              if (this.remoteCamera) {
                this.style.setCenterOfRotation(
                  this.remoteCamera.getFocalPoint()
                );
              }
            }

            if (nextState.extra.centerOfRotation) {
              this.style.setCenterOfRotation(
                nextState.extra.centerOfRotation
              );
            }

            if (nextState.extra.resetCamera) {
              this.resetCamera();
            }
          }

          // Allow host to render between states
          this._sharedUpdateInProgress = false;
          this._setInteractorRenderEnabled(true);

          if (success) {
            this.vueCtx.emit("viewStateChange", nextState);
            this.vueCtx.emit("afterSceneLoaded");
          }

          if (this._sharedUpdateQueue.length) {
            await new Promise((resolve) => raf(resolve));
            this._sharedUpdateInProgress = true;
            this._setInteractorRenderEnabled(false);
          }
        }
      } finally {
        this.busy.stop();
        this._setInteractorRenderEnabled(true);
        this._sharedUpdateInProgress = false;
        this._sharedUpdateRunnerActive = false;
      }
    }

    _applyQueuedStateSynchronously() {
      if (!this._sharedUpdateQueue?.length) {
        return false;
      }

      this.vueCtx.emit("beforeSceneLoaded");

      let lastSuccessfulState = null;

      while (this._sharedUpdateQueue.length) {
        const nextState = this._sharedUpdateQueue.shift();

        // Inject cached array content for arrays missing inline data
        this._injectCachedContent(nextState);

        this.mtime = Math.max(this.mtime, nextState.mtime) + 1;
        nextState.mtime = this.mtime;

        // Use synchronous path if inline data is available
        let success = false;
        if (this.hasInlineData(nextState)) {
          success = this._synchronizeStateSync(nextState, true);
        } else {
          const progress = this.renderWindow.synchronize(nextState);
          success = !!progress;
        }

        if (success) {
          if (this.renderWindow.getRenderersByReference().length) {
            [this.renderer] = this.renderWindow.getRenderersByReference();
            this.activeCamera = this.renderer.getActiveCamera();
          }
          if (nextState.extra?.camera && this.activeCamera) {
            this.ctx.registerInstance(
              nextState.extra.camera,
              this.activeCamera
            );
          }

          lastSuccessfulState = nextState;

          if (nextState.extra) {
            if (nextState.extra.camera) {
              this.remoteCamera = this.ctx.getInstance(nextState.extra.camera);
              if (this.remoteCamera) {
                this.style.setCenterOfRotation(
                  this.remoteCamera.getFocalPoint()
                );
              }
            }
            if (nextState.extra.centerOfRotation) {
              this.style.setCenterOfRotation(nextState.extra.centerOfRotation);
            }
            if (nextState.extra.resetCamera) {
              this.resetCamera();
            }
          }
        }
      }

      if (lastSuccessfulState) {
        this.vueCtx.emit("viewStateChange", lastSuccessfulState);
      }
      this.vueCtx.emit("afterSceneLoaded");

      return !!lastSuccessfulState;
    }

    renderShared(options = {}) {
      const { skipRender = false, ...renderOptions } = options;

      this._applyQueuedStateSynchronously();
      if (!skipRender) {
        this.openglRenderWindow.renderShared(renderOptions);
      }
    }

    onRenderRequested(callback) {
      this._renderRequestedCallback = callback;

      if (this.openglRenderWindow?.setRenderCallback) {
        this.openglRenderWindow.setRenderCallback(callback);
      }
    }

    _setInteractorRenderEnabled(enabled) {
      const interactor = this.renderWindow?.getInteractor?.();
      if (!interactor?.setEnableRender) {
        return;
      }

      if (this._renderRequestedCallback) {
        interactor.setEnableRender(false);
        return;
      }

      interactor.setEnableRender(enabled);
    }
  };
}
