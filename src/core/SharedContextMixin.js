import vtkSharedRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/SharedRenderWindow";

export function withSharedContext(BaseView) {
  return class SharedContextView extends BaseView {
    initializeForSharedContext(canvas, gl, options = {}) {
      this._sharedContext = true;
      this.renderWindow.removeView(this.openglRenderWindow);
      this.openglRenderWindow.delete();
      this.openglRenderWindow = vtkSharedRenderWindow.createFromContext(canvas, gl, options);
      this.renderWindow.addView(this.openglRenderWindow);
      this.interactor.setView(this.openglRenderWindow);

      if (this.selector) {
        this.selector.attach(this.openglRenderWindow, this.renderer);
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
