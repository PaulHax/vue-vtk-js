import vtkSharedRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/SharedRenderWindow";

function getSharedDebugEvents() {
  if (typeof globalThis === "undefined") {
    return null;
  }
  if (!globalThis._vtkSharedDebugEnabled) {
    return null;
  }
  if (!globalThis._vtkSharedDebugEvents) {
    globalThis._vtkSharedDebugEvents = [];
  }
  return globalThis._vtkSharedDebugEvents;
}

export function withSharedContext(BaseView) {
  return class SharedContextView extends BaseView {
    initializeForSharedContext(canvas, gl, options = {}) {
      this._sharedContext = true;
      this._sharedUpdateInProgress = false;
      this._sharedUpdateQueue = [];
      const { batchSharedUpdates = false, ...contextOptions } = options || {};
      this._sharedBatchUpdates = !!batchSharedUpdates;
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
    }

    async updateViewState(remoteState) {
      if (!this._sharedUpdateQueue) {
        this._sharedUpdateQueue = [];
      }
      const debugEvents = getSharedDebugEvents();
      const pushDebug = debugEvents
        ? (event) => {
            const time =
              typeof performance !== "undefined" ? performance.now() : Date.now();
            debugEvents.push({ t: time, ...event });
          }
        : null;
      if (
        this._sharedBatchUpdates &&
        remoteState?.extra?.mapFrameId != null &&
        this._sharedUpdateQueue.length
      ) {
        const beforeLength = this._sharedUpdateQueue.length;
        this._sharedUpdateQueue = this._sharedUpdateQueue.filter(
          (state) => state?.extra?.mapFrameId == null
        );
        const dropped = beforeLength - this._sharedUpdateQueue.length;
        if (pushDebug && dropped > 0) {
          pushDebug({
            type: "coalesce",
            dropped,
            frameId: remoteState?.extra?.mapFrameId,
            seq: remoteState?.extra?.mapSyncSeq,
          });
        }
      }
      this._sharedUpdateQueue.push(remoteState);
      if (pushDebug) {
        pushDebug({
          type: "enqueue",
          queue: this._sharedUpdateQueue.length,
          mtime: remoteState?.mtime,
          seq: remoteState?.extra?.mapSyncSeq,
          frameId: remoteState?.extra?.mapFrameId,
        });
      }
      if (this._sharedUpdateInProgress) {
        return;
      }

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
          const batchSize = batchUpdates ? this._sharedUpdateQueue.length : 1;
          if (batchUpdates) {
            this.vueCtx.emit("beforeSceneLoaded");
            if (pushDebug) {
              pushDebug({
                type: "beforeSceneLoaded",
                batch: true,
                batchSize,
              });
            }
          }
          lastSuccessfulState = null;
          for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
            const nextState = this._sharedUpdateQueue.shift();

            if (!batchUpdates) {
              this.vueCtx.emit("beforeSceneLoaded");
              if (pushDebug) {
                pushDebug({
                  type: "beforeSceneLoaded",
                  seq: nextState?.extra?.mapSyncSeq,
                  frameId: nextState?.extra?.mapFrameId,
                });
              }
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
              if (nextState.extra && nextState.extra.camera && this.activeCamera) {
                this.ctx.registerInstance(
                  nextState.extra.camera,
                  this.activeCamera
                );
              }
            }

            const success = await progress;
            if (success && nextState.extra) {
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

            if (success) {
              lastSuccessfulState = nextState;
            }

            if (success && !batchUpdates) {
              // In shared context, rely on host render loop (e.g., MapLibre) to draw.
              this.vueCtx.emit("viewStateChange", nextState);
              this.vueCtx.emit("afterSceneLoaded");
              if (pushDebug) {
                pushDebug({
                  type: "afterSceneLoaded",
                  seq: nextState?.extra?.mapSyncSeq,
                  frameId: nextState?.extra?.mapFrameId,
                });
              }
            }
          }
          if (batchUpdates) {
            if (lastSuccessfulState) {
              this.vueCtx.emit("viewStateChange", lastSuccessfulState);
            }
            this.vueCtx.emit("afterSceneLoaded");
            if (pushDebug) {
              pushDebug({
                type: "afterSceneLoaded",
                batch: true,
                seq: lastSuccessfulState?.extra?.mapSyncSeq,
                frameId: lastSuccessfulState?.extra?.mapFrameId,
              });
            }
          }
          if (batchUpdates && this._sharedUpdateQueue.length) {
            await new Promise((resolve) => raf(resolve));
          }
        }
      } finally {
        this.busy.stop();
        this.renderWindow.getInteractor().setEnableRender(true);
        this._sharedUpdateInProgress = false;
      }
    }

    renderShared(options = {}) {
      // Force enableRender=true to ensure render happens even during scene updates
      // (updateViewState sets enableRender=false which would skip the render)
      const savedEnableRender = this.interactor.getEnableRender();
      this.interactor.setEnableRender(true);
      this.openglRenderWindow.renderShared(options);
      this.interactor.setEnableRender(savedEnableRender);
    }

    onRenderRequested(callback) {
      this.renderWindow.setExternalRenderCallback(callback);
    }
  };
}
