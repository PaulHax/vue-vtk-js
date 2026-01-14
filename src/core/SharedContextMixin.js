import vtkSharedRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/SharedRenderWindow";
import vtkSharedSynchronizableRenderWindow from "@kitware/vtk.js/Rendering/Misc/SharedSynchronizableRenderWindow";
import vtkObjectManager from "@kitware/vtk.js/Rendering/Misc/SynchronizableRenderWindow/ObjectManager";
import vtkOpenGLFramebuffer from "@kitware/vtk.js/Rendering/OpenGL/Framebuffer";
import vtkRenderer from "@kitware/vtk.js/Rendering/Core/Renderer";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";

function getSharedDebugEvents() {
  const root = typeof window !== "undefined" ? window : null;
  if (!root || !root._vtkSharedDebugEnabled) {
    return null;
  }
  if (!root._vtkSharedDebugEvents) {
    root._vtkSharedDebugEvents = [];
  }
  return root._vtkSharedDebugEvents;
}

// Flicker tracking - always enabled for diagnostics
function trackRender(type, overlayValid, hasTexture, updateInProgress) {
  const root = typeof window !== "undefined" ? window : null;
  if (!root) return;
  if (!root._vtkFlickerStats) {
    root._vtkFlickerStats = {
      flickerCount: 0,
      compositeCount: 0,
      freshRenderCount: 0,
      renderDuringSyncCount: 0,
      lastFlickerTime: null,
    };
  }
  const stats = root._vtkFlickerStats;
  if (type === "flicker") {
    stats.flickerCount += 1;
    stats.lastFlickerTime = Date.now();
    console.warn(
      `[VTK-FLICKER] Flicker! overlayValid=${overlayValid} hasTexture=${hasTexture} total=${stats.flickerCount}`
    );
  } else if (type === "composite") {
    stats.compositeCount += 1;
  } else if (type === "fresh") {
    stats.freshRenderCount += 1;
  }
  if (updateInProgress) {
    stats.renderDuringSyncCount += 1;
  }
}

export function withSharedContext(BaseView) {
  return class SharedContextView extends BaseView {
    _ensureSharedOverlayResources() {
      if (!this._sharedContext || !this.openglRenderWindow) {
        return false;
      }

      const gl = this.openglRenderWindow.getContext?.();
      if (!gl) {
        return false;
      }

      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      if (!width || !height) {
        return false;
      }

      const sizeChanged =
        !this._sharedOverlaySize ||
        this._sharedOverlaySize[0] !== width ||
        this._sharedOverlaySize[1] !== height;

      if (!this._sharedOverlayFramebuffer || sizeChanged) {
        // (Re)create the offscreen framebuffer + color texture.
        this._sharedOverlayValid = false;
        this._sharedOverlaySize = [width, height];

        const fb = vtkOpenGLFramebuffer.newInstance();
        fb.setOpenGLRenderWindow(this.openglRenderWindow);
        fb.create(width, height);
        fb.populateFramebuffer();
        this._sharedOverlayFramebuffer = fb;
        this._sharedOverlayTexture = fb.getColorTexture?.() || null;
      }

      if (!this._sharedOverlayProgram) {
        const compile = (type, source) => {
          const shader = gl.createShader(type);
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            gl.deleteShader(shader);
            return null;
          }
          return shader;
        };

        const vs = compile(
          gl.VERTEX_SHADER,
          [
            "attribute vec2 aPos;",
            "attribute vec2 aUV;",
            "varying vec2 vUV;",
            "void main() {",
            "  vUV = aUV;",
            "  gl_Position = vec4(aPos, 0.0, 1.0);",
            "}",
          ].join("\n")
        );
        const fs = compile(
          gl.FRAGMENT_SHADER,
          [
            "precision mediump float;",
            "uniform sampler2D uTex;",
            "varying vec2 vUV;",
            "void main() {",
            "  gl_FragColor = texture2D(uTex, vUV);",
            "}",
          ].join("\n")
        );
        if (!vs || !fs) {
          return true;
        }

        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          gl.deleteProgram(program);
          return true;
        }

        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        // Interleaved: x, y, u, v
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([
            -1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1,
          ]),
          gl.STATIC_DRAW
        );

        this._sharedOverlayProgram = program;
        this._sharedOverlayBuffer = buffer;
        this._sharedOverlayAttribPos = gl.getAttribLocation(program, "aPos");
        this._sharedOverlayAttribUV = gl.getAttribLocation(program, "aUV");
        this._sharedOverlayUniformTex = gl.getUniformLocation(program, "uTex");
      }

      return true;
    }

    _compositeSharedOverlay() {
      if (!this._sharedOverlayValid || !this._sharedOverlayTexture) {
        return;
      }

      const gl = this.openglRenderWindow.getContext?.();
      if (!gl || !this._sharedOverlayProgram || !this._sharedOverlayBuffer) {
        return;
      }

      // Draw the cached overlay texture over the current framebuffer.
      gl.useProgram(this._sharedOverlayProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._sharedOverlayBuffer);

      const stride = 4 * 4;
      gl.enableVertexAttribArray(this._sharedOverlayAttribPos);
      gl.vertexAttribPointer(
        this._sharedOverlayAttribPos,
        2,
        gl.FLOAT,
        false,
        stride,
        0
      );
      gl.enableVertexAttribArray(this._sharedOverlayAttribUV);
      gl.vertexAttribPointer(
        this._sharedOverlayAttribUV,
        2,
        gl.FLOAT,
        false,
        stride,
        2 * 4
      );

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._sharedOverlayTexture.getHandle());
      gl.uniform1i(this._sharedOverlayUniformTex, 0);

      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      // Overlay texture is effectively premultiplied due to blending over transparent.
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Put GL back into a neutral state for the shared context host.
      this.openglRenderWindow.restoreSharedState?.();
    }

    initializeForSharedContext(canvas, gl, options = {}) {
      try {
        console.log('[SharedContext] Starting initialization');
        this._sharedContext = true;
      // Render gating flag: true only while we are actively applying state.
      // (Host render loops like MapLibre can safely render between batches.)
      this._sharedUpdateInProgress = false;
      // Runner lock: prevents concurrent queue drainers.
      this._sharedUpdateRunnerActive = false;
      this._sharedUpdateQueue = [];
      this._sharedLastFrameId = null;
      this._sharedLastSyncSeq = null;

      // Cached overlay rendering (prevents flicker when host clears each frame).
      this._sharedOverlayFramebuffer = null;
      this._sharedOverlayTexture = null;
      this._sharedOverlaySize = null;
      this._sharedOverlayValid = false;
      this._sharedOverlayProgram = null;
      this._sharedOverlayBuffer = null;
      this._sharedOverlayAttribPos = -1;
      this._sharedOverlayAttribUV = -1;
      this._sharedOverlayUniformTex = null;

      // Ping-pong double buffer (alternative to copy-pixels)
      this._pingPongFBOs = [null, null];
      this._pingPongTextures = [null, null];
      this._pingPongDepthBuffers = [null, null];
      this._pingPongFront = 0; // Index of front buffer (0 or 1)
      this._pingPongSize = null;
      this._pingPongValid = false;

      // Dual renderer approach - shadow renderer for flicker-free rendering
      this._shadowRenderer = null;
      this._shadowActors = new Map(); // Maps original actor to shadow actor
      this._shadowValid = false;

      // Sync-at-render mode (deck.gl style): queue state, apply at render time
      this._syncStateAtRender = false;
      this._requestRepaintCallback = null;

      const {
        batchSharedUpdates = false,
        // When an external render loop drives rendering (MapLibre, deck.gl, etc), it may
        // call render while a remote-state synchronization is mid-flight. Rendering a
        // partially-applied state can cause visible jitter (e.g., lines detaching from
        // footprints). Default is to skip renders during updates and rely on the host
        // to repaint after `afterSceneLoaded`.
        allowRenderDuringUpdate = false,
        // Deck.gl-style sync: queue state when it arrives, apply synchronously at render.
        // Eliminates flicker by making state application atomic with rendering.
        // Requires host to call triggerRepaint when state arrives.
        syncStateAtRender = false,
        ...contextOptions
      } = options || {};
      this._sharedBatchUpdates = !!batchSharedUpdates;
      this._sharedAllowRenderDuringUpdate = !!allowRenderDuringUpdate;
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

      console.log('[SharedContext] Initialization complete');
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

        this._sharedLastSyncSeq = state?.extra?.mapSyncSeq ?? null;
        this._sharedLastFrameId = state?.extra?.mapFrameId ?? null;

        this.vueCtx.emit("viewStateChange", state);
      }

      this.vueCtx.emit("afterSceneLoaded");
      return success;
    }

    async updateViewState(remoteState) {
      if (!this._sharedUpdateQueue) {
        this._sharedUpdateQueue = [];
      }
      const debugEvents = getSharedDebugEvents();
      const pushDebug = debugEvents
        ? (event) => {
            const time =
              typeof performance !== "undefined"
                ? performance.now()
                : Date.now();
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

      // Note: We previously had pre-sync overlay rendering here to prevent flicker,
      // but it caused clipping issues because the projection matrix wasn't set up
      // correctly outside of MapLibre's render loop. The flicker fix now relies on:
      // 1. Event emission reordering (afterSceneLoaded after _sharedUpdateInProgress=false)
      // 2. Error handling in renderShared to ensure tracking works

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
              this._sharedLastSyncSeq = nextState?.extra?.mapSyncSeq ?? null;
              this._sharedLastFrameId = nextState?.extra?.mapFrameId ?? null;
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
          // Allow host to render the coherent committed state at least once
          // between update batches.
          this._sharedUpdateInProgress = false;
          this.renderWindow.getInteractor().setEnableRender(true);

          // Sync shadow actors for dual renderer approach (flicker prevention)
          // This copies current actor state to shadow renderer for next sync
          this._ensureShadowRenderer();
          this._syncShadowActors();

          // Emit events AFTER _sharedUpdateInProgress = false so camera + geometry
          // are both ready when the first render happens (prevents jitter in
          // MapLibre shared context where camera is applied in afterSceneLoaded)
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

    _ensureCopyTexture(gl, width, height) {
      if (
        this._copyTexture &&
        this._copyTextureSize?.[0] === width &&
        this._copyTextureSize?.[1] === height
      ) {
        return this._copyTexture;
      }

      if (this._copyTexture) {
        gl.deleteTexture(this._copyTexture);
      }

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this._copyTexture = tex;
      this._copyTextureSize = [width, height];
      this._copyTextureValid = false;

      return tex;
    }

    _compositeCopyTexture(gl) {
      if (!this._copyTextureValid || !this._copyTexture) {
        return false;
      }

      if (!this._sharedOverlayProgram || !this._sharedOverlayBuffer) {
        this._ensureSharedOverlayResources();
        if (!this._sharedOverlayProgram) return false;
      }

      gl.useProgram(this._sharedOverlayProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._sharedOverlayBuffer);

      const stride = 4 * 4;
      gl.enableVertexAttribArray(this._sharedOverlayAttribPos);
      gl.vertexAttribPointer(
        this._sharedOverlayAttribPos,
        2,
        gl.FLOAT,
        false,
        stride,
        0
      );
      gl.enableVertexAttribArray(this._sharedOverlayAttribUV);
      gl.vertexAttribPointer(
        this._sharedOverlayAttribUV,
        2,
        gl.FLOAT,
        false,
        stride,
        2 * 4
      );

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._copyTexture);
      gl.uniform1i(this._sharedOverlayUniformTex, 0);

      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      this.openglRenderWindow.restoreSharedState?.();
      return true;
    }

    _ensurePingPongFBOs(gl, width, height) {
      const sizeChanged =
        !this._pingPongSize ||
        this._pingPongSize[0] !== width ||
        this._pingPongSize[1] !== height;

      if (!sizeChanged && this._pingPongFBOs[0] && this._pingPongFBOs[1]) {
        return true;
      }

      // Clean up old resources
      for (let i = 0; i < 2; i++) {
        if (this._pingPongFBOs[i]) {
          gl.deleteFramebuffer(this._pingPongFBOs[i]);
        }
        if (this._pingPongTextures[i]) {
          gl.deleteTexture(this._pingPongTextures[i]);
        }
        if (this._pingPongDepthBuffers[i]) {
          gl.deleteRenderbuffer(this._pingPongDepthBuffers[i]);
        }
      }

      // Create two FBOs with color textures and depth buffers
      for (let i = 0; i < 2; i++) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          width,
          height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Create depth renderbuffer
        const depthBuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
        gl.renderbufferStorage(
          gl.RENDERBUFFER,
          gl.DEPTH_COMPONENT16,
          width,
          height
        );

        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          tex,
          0
        );
        gl.framebufferRenderbuffer(
          gl.FRAMEBUFFER,
          gl.DEPTH_ATTACHMENT,
          gl.RENDERBUFFER,
          depthBuffer
        );

        // Check FBO is complete
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
          console.warn(`[VTK] Ping-pong FBO ${i} incomplete: ${status}`);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          return false;
        }

        this._pingPongFBOs[i] = fbo;
        this._pingPongTextures[i] = tex;
        this._pingPongDepthBuffers[i] = depthBuffer;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._pingPongSize = [width, height];
      this._pingPongValid = false;
      this._pingPongFront = 0;

      return true;
    }

    _compositePingPongFront(gl) {
      if (!this._pingPongValid) {
        return false;
      }

      const frontTex = this._pingPongTextures[this._pingPongFront];
      if (!frontTex) {
        return false;
      }

      if (!this._sharedOverlayProgram || !this._sharedOverlayBuffer) {
        this._ensureSharedOverlayResources();
        if (!this._sharedOverlayProgram) return false;
      }

      gl.useProgram(this._sharedOverlayProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._sharedOverlayBuffer);

      const stride = 4 * 4;
      gl.enableVertexAttribArray(this._sharedOverlayAttribPos);
      gl.vertexAttribPointer(
        this._sharedOverlayAttribPos,
        2,
        gl.FLOAT,
        false,
        stride,
        0
      );
      gl.enableVertexAttribArray(this._sharedOverlayAttribUV);
      gl.vertexAttribPointer(
        this._sharedOverlayAttribUV,
        2,
        gl.FLOAT,
        false,
        stride,
        2 * 4
      );

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, frontTex);
      gl.uniform1i(this._sharedOverlayUniformTex, 0);

      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      this.openglRenderWindow.restoreSharedState?.();
      return true;
    }

    // APPROACH 4: Dual renderer with shadow actors
    _ensureShadowRenderer() {
      if (this._shadowRenderer) {
        return true;
      }

      if (!this.renderWindow || !this.renderer) {
        return false;
      }

      // Create shadow renderer on layer 1 (behind main renderer on layer 0)
      this._shadowRenderer = vtkRenderer.newInstance();
      this._shadowRenderer.setLayer(1);
      this._shadowRenderer.setInteractive(false);
      this._shadowRenderer.setDraw(false); // Start hidden

      // Copy background from main renderer
      this._shadowRenderer.setBackground(this.renderer.getBackground());

      this.renderWindow.addRenderer(this._shadowRenderer);
      return true;
    }

    _syncShadowActors() {
      if (!this._shadowRenderer || !this.renderer) {
        return;
      }

      // Ensure map exists
      if (!this._shadowActors) {
        this._shadowActors = new Map();
      }

      const mainActors = this.renderer.getActors();

      // Remove shadow actors that no longer have a main actor
      for (const [mainActor, shadowActor] of this._shadowActors) {
        if (!mainActors.includes(mainActor)) {
          this._shadowRenderer.removeActor(shadowActor);
          shadowActor.delete?.();
          this._shadowActors.delete(mainActor);
        }
      }

      // For each main actor, ensure shadow exists and copy state
      for (const mainActor of mainActors) {
        let shadowActor = this._shadowActors.get(mainActor);

        if (!shadowActor) {
          // Clone the actor
          shadowActor = this._cloneActor(mainActor);
          if (shadowActor) {
            this._shadowActors.set(mainActor, shadowActor);
            this._shadowRenderer.addActor(shadowActor);
          }
        }

        if (shadowActor) {
          // Copy current state from main to shadow
          this._copyActorState(mainActor, shadowActor);
        }
      }

      // Copy camera state
      const mainCamera = this.renderer.getActiveCamera();
      const shadowCamera = this._shadowRenderer.getActiveCamera();
      if (mainCamera && shadowCamera) {
        shadowCamera.setPosition(...mainCamera.getPosition());
        shadowCamera.setFocalPoint(...mainCamera.getFocalPoint());
        shadowCamera.setViewUp(...mainCamera.getViewUp());
        shadowCamera.setClippingRange(...mainCamera.getClippingRange());
        if (mainCamera.getParallelProjection) {
          shadowCamera.setParallelProjection(
            mainCamera.getParallelProjection()
          );
          shadowCamera.setParallelScale(mainCamera.getParallelScale());
        }
      }

      this._shadowValid = true;
    }

    _cloneActor(actor) {
      // Simple shallow clone - create new actor with same mapper
      if (!actor) {
        return null;
      }

      const clone = vtkActor.newInstance();

      // Share the mapper (geometry data)
      const mapper = actor.getMapper?.();
      if (mapper) {
        clone.setMapper(mapper);
      }

      // Copy properties
      this._copyActorState(actor, clone);

      return clone;
    }

    _copyActorState(src, dst) {
      if (!src || !dst) return;

      // Copy transform
      if (src.getUserMatrix && dst.setUserMatrix) {
        const matrix = src.getUserMatrix();
        if (matrix) {
          dst.setUserMatrix(matrix);
        }
      }

      // Copy visibility
      if (src.getVisibility && dst.setVisibility) {
        dst.setVisibility(src.getVisibility());
      }

      // Copy property (color, opacity, etc)
      const srcProp = src.getProperty?.();
      const dstProp = dst.getProperty?.();
      if (srcProp && dstProp) {
        if (srcProp.getColor && dstProp.setColor) {
          dstProp.setColor(...srcProp.getColor());
        }
        if (srcProp.getOpacity && dstProp.setOpacity) {
          dstProp.setOpacity(srcProp.getOpacity());
        }
      }
    }

    _renderShadowRenderer() {
      if (!this._shadowRenderer || !this._shadowValid) {
        return false;
      }

      // Temporarily swap renderers: hide main, show shadow
      const mainDraw = this.renderer?.getDraw?.() ?? true;
      this.renderer?.setDraw?.(false);
      this._shadowRenderer.setDraw(true);

      // Render
      this.openglRenderWindow.renderShared({});

      // Restore
      this._shadowRenderer.setDraw(false);
      this.renderer?.setDraw?.(mainDraw);

      return true;
    }

    _applyQueuedStateSynchronously() {
      if (!this._sharedUpdateQueue?.length) {
        return false;
      }

      const debugEvents = getSharedDebugEvents();
      const pushDebug = debugEvents
        ? (event) => {
            const time =
              typeof performance !== "undefined"
                ? performance.now()
                : Date.now();
            debugEvents.push({ t: time, ...event });
          }
        : null;

      this.vueCtx.emit("beforeSceneLoaded");
      if (pushDebug) {
        pushDebug({
          type: "beforeSceneLoaded",
          syncAtRender: true,
          queueLength: this._sharedUpdateQueue.length,
        });
      }

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
          this._sharedLastSyncSeq = nextState?.extra?.mapSyncSeq ?? null;
          this._sharedLastFrameId = nextState?.extra?.mapFrameId ?? null;

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
      if (pushDebug) {
        pushDebug({
          type: "afterSceneLoaded",
          syncAtRender: true,
          seq: lastSuccessfulState?.extra?.mapSyncSeq,
          frameId: lastSuccessfulState?.extra?.mapFrameId,
        });
      }

      return !!lastSuccessfulState;
    }

    renderShared(options = {}) {
      const { skipRender = false, ...renderOptions } = options;

      // Sync-at-render mode (deck.gl style): apply all queued state first, then render
      if (this._syncStateAtRender) {
        this._applyQueuedStateSynchronously();
        if (!skipRender) {
          trackRender("fresh", false, false, false);
          this.openglRenderWindow.renderShared(renderOptions);
        }
        return;
      }

      // Legacy mode: async state sync with copy-pixels flicker prevention
      const updateInProgress = !!this._sharedUpdateInProgress;

      if (updateInProgress) {
        const gl = this.openglRenderWindow?.getContext?.();
        if (gl && this._compositeCopyTexture(gl)) {
          trackRender("composite", true, true, true);
          return;
        }
        trackRender("flicker", false, false, true);
        return;
      }

      trackRender("fresh", false, false, false);
      this.openglRenderWindow.renderShared(options);

      const gl = this.openglRenderWindow?.getContext?.();
      if (gl) {
        const canvas = gl.canvas;
        const width = canvas.width;
        const height = canvas.height;
        this._ensureCopyTexture(gl, width, height);
        gl.bindTexture(gl.TEXTURE_2D, this._copyTexture);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
        this._copyTextureValid = true;
        this.openglRenderWindow.restoreSharedState?.();
      }
    }

    onRenderRequested(callback) {
      this.renderWindow.setExternalRenderCallback(callback);
    }
  };
}
