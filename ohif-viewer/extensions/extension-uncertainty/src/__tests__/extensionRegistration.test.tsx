import extension from '../index';

function buildServicesManager() {
  const servicesManager: any = {
    services: {},
    registerService: jest.fn(({ name, create }) => {
      servicesManager.services[name] = create();
    }),
  };
  return servicesManager;
}

describe('extension preRegistration startup safety', () => {
  it('registers uncertaintyService without throwing when uncertainty config is absent', () => {
    const servicesManager = buildServicesManager();

    expect(() =>
      extension.preRegistration({
        servicesManager,
        commandsManager: {},
        extensionManager: { _appConfig: {} },
      } as any)
    ).not.toThrow();

    expect(servicesManager.registerService).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'uncertaintyService' })
    );
    expect(servicesManager.services.uncertaintyService).toBeDefined();
  });

  it('surfaces a clear missing-backend error from uncertainty actions', async () => {
    const servicesManager = buildServicesManager();
    extension.preRegistration({
      servicesManager,
      commandsManager: {},
      extensionManager: { _appConfig: {} },
    } as any);

    await expect(
      servicesManager.services.uncertaintyService.refreshWorklist()
    ).rejects.toThrow(/uncertaintyServiceUrl/i);
  });

  it('uses provided uncertaintyServiceUrl when config is available', async () => {
    const servicesManager = buildServicesManager();
    const mockResponse: any = {
      ok: true,
      status: 200,
      json: async () => [],
      headers: { get: () => null },
    };
    mockResponse.clone = () => mockResponse;
    const fetchImpl = jest.fn().mockResolvedValue(mockResponse);

    extension.preRegistration({
      servicesManager,
      commandsManager: {},
      extensionManager: { _appConfig: {} },
      configuration: {
        uncertaintyServiceUrl: 'http://localhost:58050',
        fetchImpl,
      },
    } as any);

    await servicesManager.services.uncertaintyService.refreshWorklist('fifo');
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost:58050/worklist?'),
      expect.objectContaining({ method: 'GET' })
    );
  });
});
