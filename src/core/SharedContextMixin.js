import vtkSharedRenderWindow from "@kitware/vtk.js/Rendering/OpenGL/SharedRenderWindow";

export function withSharedContext(BaseView) {
  return class SharedContextView extends BaseView {
    initializeForSharedContext(canvas, gl, options = {}) {
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
      this.openglRenderWindow.renderShared(options);
    }

    onRenderRequested(callback) {
      this.renderWindow.setExternalRenderCallback(callback);
    }
  };
}
