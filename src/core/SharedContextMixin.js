import vtkSharedRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/SharedRenderWindow";
import vtkSharedSynchronizableRenderWindow from "@kitware/vtk.js/Rendering/Misc/SharedSynchronizableRenderWindow";
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

      // Sync-at-render mode (deck.gl style): queue state, apply at render time
      this._syncStateAtRender = false;
      this._requestRepaintCallback = null;

      const {
        batchSharedUpdates = false,
        // Deck.gl-style sync: queue state when it arrives, apply synchronously at render.
        // Eliminates flicker by making state application atomic with rendering.
        // Requires host to call triggerRepaint when state arrives.
        syncStateAtRender = false,
        ...contextOptions
      } = options || {};
      this._sharedBatchUpdates = !!batchSharedUpdates;
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
      } catch (e) {
        console.error('[SharedContext] Initialization error:', e, e?.message, e?.stack);
        throw e;
      }
    }

    // Utility methods that use the imported functions
    hasInlineData(state) {
      return vtkSharedSynchronizableRenderWindow.allArraysHaveInlineData(state);
    }

    _synchronizeStateSync(state, skipRender = false) {
      try {
        const context = this.ctx;
        if (!context) {
          console.error('[SharedContext] _synchronizeStateSync: context is undefined');
          return false;
        }

        vtkSharedSynchronizableRenderWindow.updateRenderWindowSync(
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

    /**
     * Synchronously apply state - for use in MapLibre/deck.gl render callbacks.
     * Requires state to have inline array data (base64-encoded content fields).
     * @param {Object} state - State with inline array data
     * @param {boolean} skipRender - If true, skip the final render call
     * @returns {boolean} - true if state was applied
     */
    synchronizeSync(state, skipRender = false) {
      if (!this.hasInlineData(state)) {
        console.warn(
          "synchronizeSync: state missing inline data, falling back to async"
        );
        this.updateViewState(state);
        return false;
      }

      this.vueCtx.emit("beforeSceneLoaded");

      this.mtime = Math.max(this.mtime, state.mtime || 0) + 1;
      state.mtime = this.mtime;

      const success = this._synchronizeStateSync(state, skipRender);

      if (success) {
        if (this.renderWindow.getRenderersByReference().length) {
          [this.renderer] = this.renderWindow.getRenderersByReference();
          this.activeCamera = this.renderer.getActiveCamera();
        }
        if (state.extra?.camera && this.activeCamera) {
          this.ctx.registerInstance(state.extra.camera, this.activeCamera);
        }
        if (state.extra) {
          if (state.extra.camera) {
            this.remoteCamera = this.ctx.getInstance(state.extra.camera);
            if (this.remoteCamera) {
              this.style.setCenterOfRotation(this.remoteCamera.getFocalPoint());
            }
          }
          if (state.extra.centerOfRotation) {
            this.style.setCenterOfRotation(state.extra.centerOfRotation);
          }
          if (state.extra.resetCamera) {
            this.resetCamera();
          }
        }

        this.vueCtx.emit("viewStateChange", state);
      }

      this.vueCtx.emit("afterSceneLoaded");
      return success;
    }

    async updateViewState(remoteState) {
      if (!this._sharedUpdateQueue) {
        this._sharedUpdateQueue = [];
      }
      if (
        this._sharedBatchUpdates &&
        remoteState?.extra?.mapFrameId != null &&
        this._sharedUpdateQueue.length
      ) {
        this._sharedUpdateQueue = this._sharedUpdateQueue.filter(
          (state) => state?.extra?.mapFrameId == null
        );
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
      this.renderWindow.getInteractor().setEnableRender(false);
      this.busy.reset();
      this.busy.start();
      const batchUpdates = !!this._sharedBatchUpdates;
      let lastSuccessfulState = null;

      try {
        const raf =
          typeof requestAnimationFrame === "function"
            ? requestAnimationFrame
            : (cb) => setTimeout(cb, 0);
        while (this._sharedUpdateQueue.length) {
          // In shared-context hosts (MapLibre/deck.gl), the host clears the
          // framebuffer every frame. If we hold the update lock for too long,
          // host renders will clear without VTK redraw, which presents as
          // flicker or total disappearance at higher playback speeds.
          //
          // We bound batch size to ensure we yield and allow coherent renders
          // between batches.
          const maxBatchSize = 25;
          const batchSize = batchUpdates
            ? Math.min(this._sharedUpdateQueue.length, maxBatchSize)
            : 1;
          if (batchUpdates) {
            this.vueCtx.emit("beforeSceneLoaded");
          }
          lastSuccessfulState = null;
          for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
            const nextState = this._sharedUpdateQueue.shift();

            if (!batchUpdates) {
              this.vueCtx.emit("beforeSceneLoaded");
            }

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

            if (success) {
              lastSuccessfulState = nextState;
            }

            if (success && !batchUpdates) {
              // In shared context, rely on host render loop (e.g., MapLibre) to draw.
              this.vueCtx.emit("viewStateChange", nextState);
              this.vueCtx.emit("afterSceneLoaded");
            }
          }
          // Allow host to render the coherent committed state at least once
          // between update batches.
          this._sharedUpdateInProgress = false;
          this.renderWindow.getInteractor().setEnableRender(true);

          // Emit events AFTER _sharedUpdateInProgress = false so camera + geometry
          // are both ready when the first render happens (prevents jitter in
          // MapLibre shared context where camera is applied in afterSceneLoaded)
          if (batchUpdates) {
            if (lastSuccessfulState) {
              this.vueCtx.emit("viewStateChange", lastSuccessfulState);
            }
            this.vueCtx.emit("afterSceneLoaded");
          }

          if (this._sharedUpdateQueue.length) {
            await new Promise((resolve) => raf(resolve));
            this._sharedUpdateInProgress = true;
            this.renderWindow.getInteractor().setEnableRender(false);
          }
        }
      } finally {
        this.busy.stop();
        this.renderWindow.getInteractor().setEnableRender(true);
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
      this.renderWindow.setExternalRenderCallback(callback);
    }
  };
}
