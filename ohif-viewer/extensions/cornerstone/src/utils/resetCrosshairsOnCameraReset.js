export default function createResetCrosshairsOnCameraReset({
  commandsManager,
  getEnabledElement,
}) {
  return function resetCrosshairsOnCameraReset(evt) {
    const { element } = evt.detail;
    const enabledElement = getEnabledElement(element);

    if (!enabledElement) {
      return;
    }

    const { viewportId } = enabledElement;
    commandsManager.runCommand('resetCrosshairs', { viewportId });
  };
}
