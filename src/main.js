// Ensure vtk.js classes available for Algorithm and Reader
import "./AvailableClasses";
import components from "./components";
import filters from "./filters";

// Export vtk.js classes for client-side texture creation
import vtkTexture from "@kitware/vtk.js/Rendering/Core/Texture";
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";

export function install(Vue) {
  Object.keys(components).forEach((name) => {
    Vue.component(name, components[name]);
  });

  if (window?.trame?.utils?.vtk) {
    Object.keys(filters).forEach((name) => {
      window.trame.utils.vtk[name] = filters[name];
    });
    // Export vtk classes for client-side texture creation
    window.trame.utils.vtk.vtkTexture = vtkTexture;
    window.trame.utils.vtk.vtkImageData = vtkImageData;
    window.trame.utils.vtk.vtkDataArray = vtkDataArray;
  }
}

export const vtkColorPresetNames = filters.vtkColorPresetNames;
export const vtkLabel = filters.vtkLabel;
export const ListToItem = filters.ListToItem;
export const vtkColorPresetItems = filters.vtkColorPresetItems;

// Export vtk classes
export { vtkTexture, vtkImageData, vtkDataArray };
