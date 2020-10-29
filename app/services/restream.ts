import { StatefulService, ViewHandler } from 'services';
import { Inject, mutation, InitAfter } from 'services/core';
import { HostsService } from 'services/hosts';
import { getPlatformService, TPlatform } from 'services/platforms';
import { StreamSettingsService } from 'services/settings/streaming';
import { UserService } from 'services/user';
import { authorizedHeaders, jfetch } from 'util/requests';
import { IncrementalRolloutService } from './incremental-rollout';
import electron from 'electron';
import { StreamingService } from './streaming';

interface IRestreamTarget {
  id: number;
  platform: TPlatform;
  streamKey: string;
}

interface IRestreamState {
  /**
   * Whether this user has restream enabled
   */
  enabled: boolean;

  /**
   * if true then user obtained the restream feature before it became a prime-only feature
   * Restream should be available without Prime for such users
   */
  grandfathered: boolean;
}

interface IUserSettingsResponse extends IRestreamState {
  streamKey: string;
}

@InitAfter('UserService')
export class RestreamService extends StatefulService<IRestreamState> {
  @Inject() hostsService: HostsService;
  @Inject() userService: UserService;
  @Inject() streamSettingsService: StreamSettingsService;
  @Inject() streamingService: StreamingService;
  @Inject() incrementalRolloutService: IncrementalRolloutService;

  settings: IUserSettingsResponse;

  static initialState: IRestreamState = {
    enabled: true,
    grandfathered: false,
  };

  get streamInfo() {
    return this.streamingService.views;
  }

  @mutation()
  private SET_ENABLED(enabled: boolean) {
    this.state.enabled = enabled;
  }

  @mutation()
  private SET_GRANDFATHERED(enabled: boolean) {
    this.state.grandfathered = enabled;
  }

  init() {
    this.userService.userLogin.subscribe(() => this.loadUserSettings());
    this.userService.userLogout.subscribe(() => {
      this.settings = null;
      this.SET_ENABLED(false);
    });
  }

  get views() {
    return new RestreamView(this.state);
  }

  async loadUserSettings() {
    this.settings = await this.fetchUserSettings();
    this.SET_GRANDFATHERED(this.settings.grandfathered);
    this.SET_ENABLED(this.settings.enabled && this.views.canEnableRestream);
  }

  get host() {
    return this.hostsService.streamlabs;
  }

  get chatUrl() {
    return `https://streamlabs.com/embed/chat?oauth_token=${this.userService.apiToken}`;
  }

  get shouldGoLiveWithRestream() {
    return this.streamInfo.isMultiplatformMode;
  }

  fetchUserSettings(): Promise<IUserSettingsResponse> {
    const headers = authorizedHeaders(this.userService.apiToken);
    const url = `https://${this.host}/api/v1/rst/user/settings`;
    const request = new Request(url, { headers });

    return jfetch(request);
  }

  fetchTargets(): Promise<IRestreamTarget[]> {
    const headers = authorizedHeaders(this.userService.apiToken);
    const url = `https://${this.host}/api/v1/rst/targets`;
    const request = new Request(url, { headers });

    return jfetch(request);
  }

  fetchIngest(): Promise<{ server: string }> {
    const headers = authorizedHeaders(this.userService.apiToken);
    const url = `https://${this.host}/api/v1/rst/ingest`;
    const request = new Request(url, { headers });

    return jfetch(request);
  }

  setEnabled(enabled: boolean) {
    this.SET_ENABLED(enabled);

    const headers = authorizedHeaders(
      this.userService.apiToken,
      new Headers({ 'Content-Type': 'application/json' }),
    );
    const url = `https://${this.host}/api/v1/rst/user/settings`;
    const body = JSON.stringify({
      enabled,
      dcProtection: false,
      idleTimeout: 30,
    });
    const request = new Request(url, { headers, body, method: 'PUT' });

    return jfetch(request);
  }

  get platforms(): TPlatform[] {
    return [this.userService.state.auth.primaryPlatform, 'facebook'];
  }

  async beforeGoLive() {
    await Promise.all([this.setupIngest(), this.setupTargets()]);
  }

  async setupIngest() {
    const ingest = (await this.fetchIngest()).server;

    // We need to move OBS to custom ingest mode before we can set the server
    this.streamSettingsService.setSettings({
      streamType: 'rtmp_custom',
    });

    this.streamSettingsService.setSettings({
      key: this.settings.streamKey,
      server: ingest,
    });
  }

  async setupTargets() {
    const targets = await this.fetchTargets();
    const promises = targets.map(t => this.deleteTarget(t.id));

    await Promise.all(promises);

    await this.createTargets([
      ...this.streamInfo.enabledPlatforms.map(platform => {
        return {
          platform: platform as TPlatform,
          streamKey: getPlatformService(platform).state.streamKey,
        };
      }),
      ...this.streamInfo.goLiveSettings.customDestinations
        .filter(dest => dest.enabled)
        .map(dest => ({ platform: 'relay' as 'relay', streamKey: `${dest.url}${dest.streamKey}` })),
    ]);
  }

  checkStatus(): Promise<boolean> {
    const url = `https://${this.host}/api/v1/rst/util/status`;
    const request = new Request(url);

    return jfetch<{ name: string; status: boolean }[]>(request).then(
      j => j.find(service => service.name === 'restream').status,
    );
  }

  async createTargets(targets: { platform: TPlatform | 'relay'; streamKey: string }[]) {
    const headers = authorizedHeaders(
      this.userService.apiToken,
      new Headers({ 'Content-Type': 'application/json' }),
    );
    const url = `https://${this.host}/api/v1/rst/targets`;
    const body = JSON.stringify(
      targets.map(target => {
        return {
          platform: target.platform,
          streamKey: target.streamKey,
          enabled: true,
          dcProtection: false,
          idleTimeout: 30,
          label: `${target.platform} target`,
        };
      }),
    );
    const request = new Request(url, { headers, body, method: 'POST' });
    const res = await fetch(request);
    if (!res.ok) throw await res.json();
    return res.json();
  }

  deleteTarget(id: number) {
    const headers = authorizedHeaders(this.userService.apiToken);
    const url = `https://${this.host}/api/v1/rst/targets/${id}`;
    const request = new Request(url, { headers, method: 'DELETE' });

    return fetch(request);
  }

  updateTarget(id: number, streamKey: string) {
    const headers = authorizedHeaders(
      this.userService.apiToken,
      new Headers({ 'Content-Type': 'application/json' }),
    );
    const url = `https://${this.host}/api/v1/rst/targets`;
    const body = JSON.stringify([
      {
        id,
        streamKey,
      },
    ]);
    const request = new Request(url, { headers, body, method: 'PUT' });

    return fetch(request).then(res => res.json());
  }

  /* Chat Handling
   * TODO: Lots of this is copy-pasted from the chat service
   * The chat service needs to be refactored\
   */
  private chatView: Electron.BrowserView;

  refreshChat() {
    this.chatView.webContents.loadURL(this.chatUrl);
  }

  mountChat(electronWindowId: number) {
    if (!this.chatView) this.initChat();

    const win = electron.remote.BrowserWindow.fromId(electronWindowId);

    // This method was added in our fork
    (win as any).addBrowserView(this.chatView);
  }

  setChatBounds(position: IVec2, size: IVec2) {
    if (!this.chatView) return;

    this.chatView.setBounds({
      x: Math.round(position.x),
      y: Math.round(position.y),
      width: Math.round(size.x),
      height: Math.round(size.y),
    });
  }

  unmountChat(electronWindowId: number) {
    if (!this.chatView) return;

    const win = electron.remote.BrowserWindow.fromId(electronWindowId);

    // @ts-ignore: this method was added in our fork
    win.removeBrowserView(this.chatView);

    // Automatically destroy the chat if restream has been disabled
    if (!this.state.enabled) this.deinitChat();
  }

  private initChat() {
    if (this.chatView) return;

    const partition = this.userService.state.auth.partition;

    this.chatView = new electron.remote.BrowserView({
      webPreferences: {
        partition,
        nodeIntegration: false,
      },
    });

    this.chatView.webContents.loadURL(this.chatUrl);

    electron.ipcRenderer.send('webContents-preventPopup', this.chatView.webContents.id);
  }

  private deinitChat() {
    if (!this.chatView) return;

    // @ts-ignore: typings are incorrect
    this.chatView.destroy();
    this.chatView = null;
  }
}

class RestreamView extends ViewHandler<IRestreamState> {
  /**
   * This determines whether the user can enable restream
   * Requirements:
   * - Has prime, or
   * - Has a grandfathered status enabled
   */
  get canEnableRestream() {
    const userView = this.getServiceViews(UserService);
    return userView.isPrime || (userView.auth && this.state.grandfathered);
  }
}
