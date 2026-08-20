import createResetCrosshairsOnCameraReset from './resetCrosshairsOnCameraReset';

describe('createResetCrosshairsOnCameraReset', () => {
  it('ignores camera reset events before Cornerstone has enabled element metadata', () => {
    const runCommand = jest.fn();
    const handler = createResetCrosshairsOnCameraReset({
      commandsManager: { runCommand },
      getEnabledElement: () => undefined,
    });

    expect(() => handler({ detail: { element: document.createElement('div') } })).not.toThrow();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('resets crosshairs with the enabled viewport id', () => {
    const runCommand = jest.fn();
    const handler = createResetCrosshairsOnCameraReset({
      commandsManager: { runCommand },
      getEnabledElement: () => ({ viewportId: 'uncertainty-volume-viewport' }),
    });

    handler({ detail: { element: document.createElement('div') } });

    expect(runCommand).toHaveBeenCalledWith('resetCrosshairs', {
      viewportId: 'uncertainty-volume-viewport',
    });
  });
});
