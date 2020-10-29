import { mutation, InheritMutations } from '../core/stateful-service';
import {
  IPlatformService,
  TPlatformCapability,
  EPlatformCallResult,
  IPlatformRequest,
  IPlatformState,
} from '.';
import { Inject } from 'services/core/injector';
import { authorizedHeaders, handleResponse, jfetch } from 'util/requests';
import { platformAuthorizedRequest } from './utils';
import { StreamSettingsService } from 'services/settings/streaming';
import { CustomizationService } from 'services/customization';
import { IGoLiveSettings } from 'services/streaming';
import { WindowsService } from 'services/windows';
import { $t, I18nService } from 'services/i18n';
import { throwStreamError } from 'services/streaming/stream-error';
import { BasePlatformService } from './base-platform';
import { assertIsDefined } from 'util/properties-type-guards';
import electron from 'electron';
import { omitBy } from 'lodash';

interface IYoutubeServiceState extends IPlatformState {
  liveStreamingEnabled: boolean;
  streamId: string;
  broadcastStatus: TBroadcastLifecycleStatus | '';
  settings: IYoutubeStartStreamOptions;
  categories: IYoutubeCategory[];
}

export interface IYoutubeStartStreamOptions extends IExtraBroadcastSettings {
  title: string;
  categoryId?: string;
  broadcastId?: string;
  description?: string;
  privacyStatus?: 'private' | 'public' | 'unlisted';
}

/**
 * Represents an API response with a paginated collection
 */
interface IYoutubeCollection<T> {
  items: T[];
  pageInfo: { totalResults: number; resultsPerPage: number };
}

/**
 * A liveBroadcast resource represents an event that will be streamed, via live video, on YouTube.
 * For the full set of available fields:
 * @see https://google-developers.appspot.com/youtube/v3/live/docs/liveBroadcasts
 */
export interface IYoutubeLiveBroadcast {
  id: string;
  contentDetails: { boundStreamId: string } & IExtraBroadcastSettings & {
      recordFromStart: boolean;
      enableContentEncryption: boolean;
      startWithSlate: boolean;
      monitorStream: { enableMonitorStream: boolean; broadcastStreamDelayMs: boolean };
      enableEmbed: boolean;
    };
  snippet: {
    channelId: string;
    title: string;
    description: string;
    scheduledStartTime: string;
    isDefaultBroadcast: boolean;
    liveChatId: string;
    thumbnails: {
      default: {
        url: string;
        width: 120;
        height: 90;
      };
    };
  };
  status: {
    lifeCycleStatus: TBroadcastLifecycleStatus;
    privacyStatus: 'private' | 'public' | 'unlisted';
    recordingStatus: 'notRecording' | 'recorded' | 'recording';
  };
}

/**
 * A liveStream resource contains information about the video stream that you are transmitting to YouTube.
 * The stream provides the content that will be broadcast to YouTube users. Once created,
 * a liveStream resource can be bound to one or more liveBroadcast resources.
 * @see https://google-developers.appspot.com/youtube/v3/live/docs/liveStreams
 */
interface IYoutubeLiveStream {
  id: string;
  snippet: {
    isDefaultStream: boolean;
  };
  cdn: {
    ingestionInfo: {
      /**
       * streamName is actually a secret stream key
       */
      streamName: string;
      ingestionAddress: string;
    };
    resolution: string;
    frameRate: string;
  };
  status: {
    streamStatus: TStreamStatus;
  };
}

export interface IYoutubeCategory {
  id: string;
  snippet: {
    title: string;
    assignable: boolean;
  };
}

export interface IYoutubeVideo {
  id: string;
  snippet: {
    title: string;
    description: string;
    categoryId: string;
  };
}

interface IExtraBroadcastSettings {
  enableAutoStart?: boolean;
  enableAutoStop?: boolean;
  enableDvr?: boolean;
  projection?: 'rectangular' | '360';
  latencyPreference?: 'normal' | 'low' | 'ultraLow';
}

type TStreamStatus = 'active' | 'created' | 'error' | 'inactive' | 'ready';
type TBroadcastLifecycleStatus =
  | 'complete'
  | 'created'
  | 'live'
  | 'liveStarting'
  | 'ready'
  | 'revoked'
  | 'testStarting'
  | 'testing';

@InheritMutations()
export class YoutubeService extends BasePlatformService<IYoutubeServiceState>
  implements IPlatformService {
  @Inject() private customizationService: CustomizationService;
  @Inject() private streamSettingsService: StreamSettingsService;
  @Inject() private windowsService: WindowsService;
  @Inject() private i18nService: I18nService;

  readonly capabilities = new Set<TPlatformCapability>(['chat', 'description', 'stream-schedule']);

  static initialState: IYoutubeServiceState = {
    ...BasePlatformService.initialState,
    liveStreamingEnabled: true,
    streamId: '',
    broadcastStatus: '',
    categories: [],
    settings: {
      broadcastId: '',
      title: '',
      description: '',
      categoryId: '20', // Set Gaming as a default category
      enableAutoStart: true,
      enableAutoStop: true,
      enableDvr: true,
      projection: 'rectangular',
      latencyPreference: 'normal',
      privacyStatus: 'public',
    },
  };

  readonly platform = 'youtube';
  readonly displayName = 'YouTube';
  readonly updatableSettings: (keyof IYoutubeStartStreamOptions)[] = [
    'title',
    'description',
    'enableAutoStop',
    'privacyStatus',
    'enableDvr',
  ];

  authWindowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1000,
    height: 600,
  };

  private apiBase = 'https://www.googleapis.com/youtube/v3';

  protected init() {
    this.syncSettingsWithLocalStorage();
  }

  get authUrl() {
    const host = this.hostsService.streamlabs;
    return (
      `https://${host}/slobs/login?_=${Date.now()}` +
      '&skip_splash=true&external=electron&youtube&force_verify&origin=slobs'
    );
  }

  get oauthToken() {
    return this.userService.state.auth?.platforms?.youtube?.token;
  }

  /**
   * Request Youtube API and handle error response
   */
  private async requestYoutube<T = unknown>(reqInfo: IPlatformRequest | string): Promise<T> {
    try {
      return await platformAuthorizedRequest<T>('youtube', reqInfo);
    } catch (e) {
      let details = e.result?.error?.message;
      if (!details) details = 'connection failed';
      const errorType =
        details === 'The user is not enabled for live streaming.'
          ? 'YOUTUBE_STREAMING_DISABLED'
          : 'PLATFORM_REQUEST_FAILED';
      throw throwStreamError(errorType, details, 'youtube');
    }
  }

  @mutation()
  private SET_ENABLED_STATUS(enabled: boolean) {
    this.state.liveStreamingEnabled = enabled;
  }

  async beforeGoLive(settings: IGoLiveSettings) {
    const ytSettings = settings.platforms.youtube;
    // update selected LiveBroadcast with new title and description
    // or create a new LiveBroadcast if there are no broadcasts selected
    let broadcast: IYoutubeLiveBroadcast;
    if (!ytSettings.broadcastId) {
      broadcast = await this.createBroadcast(ytSettings);
    } else {
      await this.updateBroadcast(ytSettings.broadcastId, ytSettings);
      broadcast = await this.fetchBroadcast(ytSettings.broadcastId);
    }

    // create a LiveStream object and bind it with current LiveBroadcast
    let stream: IYoutubeLiveStream;
    if (!broadcast.contentDetails.boundStreamId) {
      stream = await this.createLiveStream(broadcast.snippet.title);
      await this.bindStreamToBroadcast(broadcast.id, stream.id);
    } else {
      stream = await this.fetchLiveStream(broadcast.contentDetails.boundStreamId);
    }

    // set the category
    await this.updateCategory(
      broadcast.id,
      broadcast.snippet.title,
      broadcast.snippet.description,
      ytSettings.categoryId!,
    );

    // setup key and platform type in the OBS settings
    const streamKey = stream.cdn.ingestionInfo.streamName;
    this.streamSettingsService.setSettings({
      platform: 'youtube',
      key: streamKey,
      streamType: 'rtmp_common',
    });

    // update the local state
    this.UPDATE_STREAM_SETTINGS({ ...ytSettings, broadcastId: broadcast.id });
    this.SET_STREAM_ID(stream.id);
    this.SET_STREAM_KEY(streamKey);
  }

  /**
   * check that user has enabled live-streaming on their account
   */
  async validatePlatform(): Promise<EPlatformCallResult> {
    try {
      const endpoint = 'liveStreams?part=id,snippet&mine=true';
      const url = `${this.apiBase}/${endpoint}&access_token=${this.oauthToken}`;
      await platformAuthorizedRequest('youtube', url);
      this.SET_ENABLED_STATUS(true);
      return EPlatformCallResult.Success;
    } catch (resp) {
      if (resp.status !== 403) {
        console.error('Got 403 checking if YT is enabled for live streaming', resp);
        return EPlatformCallResult.Error;
      }
      const json = resp.result;
      if (
        json.error &&
        json.error.errors &&
        json.error.errors[0].reason === 'liveStreamingNotEnabled'
      ) {
        this.SET_ENABLED_STATUS(false);
      }
      return EPlatformCallResult.YoutubeStreamingDisabled;
    }
  }

  getHeaders(req: IPlatformRequest, authorized = false) {
    return {
      'Content-Type': 'application/json',
      ...(authorized ? { Authorization: `Bearer ${this.oauthToken}` } : {}),
    };
  }

  fetchDefaultDescription(): Promise<string> {
    return this.userService
      .getDonationSettings()
      .then(json =>
        json.settings.autopublish ? `Support the stream: ${json.donation_url} \n` : '',
      );
  }

  fetchUserInfo() {
    return Promise.resolve({});
  }

  protected async fetchViewerCount(): Promise<number> {
    if (!this.state.settings.broadcastId) return 0; // activeChannel is not available when streaming to custom ingest
    const endpoint = 'videos?part=snippet,liveStreamingDetails';
    // eslint-disable-next-line prettier/prettier
    const url = `${this.apiBase}/${endpoint}&id=${this.state.settings.broadcastId}&access_token=${
      this.oauthToken
    }`;
    return this.requestYoutube<{
      items: { liveStreamingDetails: { concurrentViewers: string } }[];
    }>(url).then(
      json =>
        (json.items[0] && parseInt(json.items[0].liveStreamingDetails.concurrentViewers, 10)) || 0,
    );
  }

  private async fetchCategories(): Promise<IYoutubeCategory[]> {
    // region should be in "ISO 3166 alpha 2" format
    const locale = this.i18nService.state.locale;
    const region = locale.split('-')[1];
    const endpoint = `${this.apiBase}/videoCategories?part=snippet&regionCode=${region}&locale=${locale}`;
    const collection = await this.requestYoutube<IYoutubeCollection<IYoutubeCategory>>(endpoint);
    return collection.items.filter(category => category.snippet.assignable);
  }

  private async updateCategory(
    broadcastId: string,
    title: string,
    description: string,
    categoryId: string,
  ) {
    const endpoint = 'videos?part=snippet';
    await this.requestYoutube({
      body: JSON.stringify({ id: broadcastId, snippet: { categoryId, title, description } }),
      method: 'PUT',
      url: `${this.apiBase}/${endpoint}&access_token=${this.oauthToken}`,
    });
  }

  async fetchVideo(id: string): Promise<IYoutubeVideo> {
    const endpoint = `videos?id=${id}&part=snippet`;
    const videoCollection = await this.requestYoutube<IYoutubeCollection<IYoutubeVideo>>(
      `${this.apiBase}/${endpoint}&access_token=${this.oauthToken}`,
    );
    return videoCollection.items[0];
  }

  /**
   * returns perilled data for the GoLive window
   */
  async prepopulateInfo(): Promise<void> {
    const settings = this.state.settings;
    this.UPDATE_STREAM_SETTINGS({
      description: settings.description || (await this.fetchDefaultDescription()),
    });
    if (!this.state.categories.length) this.SET_CATEGORIES(await this.fetchCategories());
    this.SET_PREPOPULATED(true);
  }

  /**
   * Create a YT broadcast (event) for the future stream
   */
  async scheduleStream(
    scheduledStartTime: string,
    options: IYoutubeStartStreamOptions,
  ): Promise<void> {
    await this.createBroadcast(options);
  }

  async fetchNewToken(): Promise<void> {
    const host = this.hostsService.streamlabs;
    const url = `https://${host}/api/v5/slobs/youtube/token`;
    const headers = authorizedHeaders(this.userService.apiToken!);
    const request = new Request(url, { headers });

    return jfetch<{ access_token: string }>(request).then(response =>
      this.userService.updatePlatformToken('youtube', response.access_token),
    );
  }

  /**
   * update data for the current active broadcast
   */
  async putChannelInfo(options: IYoutubeStartStreamOptions): Promise<boolean> {
    const broadcastId = this.state.settings.broadcastId;
    assertIsDefined(broadcastId);
    await this.updateBroadcast(broadcastId, options);
    this.UPDATE_STREAM_SETTINGS(options);
    return true;
  }

  /**
   * create a new broadcast via API
   */
  private async createBroadcast(
    params: IYoutubeStartStreamOptions & { scheduledStartTime?: string },
  ): Promise<IYoutubeLiveBroadcast> {
    const fields = ['snippet', 'contentDetails', 'status'];
    const endpoint = `liveBroadcasts?part=${fields.join(',')}`;
    const data: Dictionary<any> = {
      snippet: {
        title: params.title,
        scheduledStartTime: params.scheduledStartTime || new Date().toISOString(),
        description: params.description,
      },
      contentDetails: {
        enableAutoStart: params.enableAutoStart,
        enableAutoStop: params.enableAutoStop,
        enableDvr: params.enableDvr,
        projection: params.projection,
        latencyPreference: params.latencyPreference,
      },
      status: { privacyStatus: params.privacyStatus },
    };

    return await this.requestYoutube<IYoutubeLiveBroadcast>({
      body: JSON.stringify(data),
      method: 'POST',
      url: `${this.apiBase}/${endpoint}&access_token=${this.oauthToken}`,
    });
  }

  /**
   * update the broadcast via API
   */
  private async updateBroadcast(
    id: string,
    params: Partial<IYoutubeStartStreamOptions>,
  ): Promise<void> {
    const broadcast = await this.fetchBroadcast(id);

    const snippet: Partial<IYoutubeLiveBroadcast['snippet']> = {
      title: params.title,
      description: params.description,
      scheduledStartTime: new Date().toISOString(),
    };

    const contentDetails: Dictionary<any> = {
      enableAutoStop: params.enableAutoStop,
      enableDvr: params.enableDvr,

      // YT requires to setup these options on broadcast update if contentDetails provided
      recordFromStart: broadcast.contentDetails.recordFromStart,
      enableContentEncryption: broadcast.contentDetails.enableContentEncryption,
      startWithSlate: broadcast.contentDetails.startWithSlate,
      monitorStream: {
        enableMonitorStream: broadcast.contentDetails.monitorStream.enableMonitorStream,
        broadcastStreamDelayMs: broadcast.contentDetails.monitorStream.broadcastStreamDelayMs,
      },
    };

    // we must provide value for `contentDetails.enableEmbed` unless the broadcast in the testing state.
    if (!['testing'].includes(broadcast.status.lifeCycleStatus)) {
      contentDetails.enableEmbed = broadcast.contentDetails.enableEmbed;
    }

    const status: Partial<IYoutubeLiveBroadcast['status']> = {
      privacyStatus: params.privacyStatus,
    };

    const fields = ['snippet', 'status', 'contentDetails'];
    const endpoint = `liveBroadcasts?part=${fields.join(',')}&id=${id}`;

    const body: Dictionary<any> = { id, snippet, contentDetails, status };
    if (params.privacyStatus) body.status = { privacyStatus: params.privacyStatus };

    await this.requestYoutube<IYoutubeLiveBroadcast>({
      body: JSON.stringify(body),
      method: 'PUT',
      url: `${this.apiBase}/${endpoint}&access_token=${this.oauthToken}`,
    });
  }

  /**
   * The liveStream must be bounded to the Youtube LiveBroadcast before going live
   */
  private bindStreamToBroadcast(
    broadcastId: string,
    streamId: string,
  ): Promise<IYoutubeLiveBroadcast> {
    const fields = ['snippet', 'contentDetails', 'status'];
    const endpoint = `/liveBroadcasts/bind?part=${fields.join(',')}`;
    return this.requestYoutube<IYoutubeLiveBroadcast>({
      method: 'POST',
      // es-lint-disable-next-line prettier/prettier
      url: `${this.apiBase}${endpoint}&id=${broadcastId}&streamId=${streamId}&access_token=${this.oauthToken}`,
    });
  }

  /**
   * create new LiveStream via API
   * this LiveStream must be bounded to the Youtube LiveBroadcast before going live
   */
  private async createLiveStream(title: string): Promise<IYoutubeLiveStream> {
    const endpoint = 'liveStreams?part=cdn,snippet,contentDetails';
    return platformAuthorizedRequest<IYoutubeLiveStream>('youtube', {
      url: `${this.apiBase}/${endpoint}&access_token=${this.oauthToken}`,
      method: 'POST',
      body: JSON.stringify({
        snippet: { title },
        cdn: {
          frameRate: 'variable',
          ingestionType: 'rtmp',
          resolution: 'variable',
        },
        contentDetails: { isReusable: false },
      }),
    });
  }

  get liveDockEnabled(): boolean {
    return this.streamSettingsService.settings.protectedModeEnabled;
  }

  /**
   * Fetch the list of upcoming and active broadcasts
   */
  async fetchBroadcasts(): Promise<IYoutubeLiveBroadcast[]> {
    const fields = ['snippet', 'contentDetails', 'status'];
    const query = `part=${fields.join(',')}&maxResults=50&access_token=${this.oauthToken}`;

    // fetch active and upcoming broadcasts simultaneously
    let [activeBroadcasts, upcomingBroadcasts] = await Promise.all([
      (
        await platformAuthorizedRequest<IYoutubeCollection<IYoutubeLiveBroadcast>>(
          'youtube',
          `${this.apiBase}/liveBroadcasts?${query}&broadcastStatus=active`,
        )
      ).items,
      (
        await platformAuthorizedRequest<IYoutubeCollection<IYoutubeLiveBroadcast>>(
          'youtube',
          `${this.apiBase}/liveBroadcasts?${query}&broadcastStatus=upcoming`,
        )
      ).items,
    ]);

    // show active broadcasts only with enableAutoStop=false
    // otherwise it's possible to start streaming to a broadcast when it's transitioning the state to completed
    activeBroadcasts = activeBroadcasts.filter(
      broadcast => !broadcast.contentDetails.enableAutoStop,
    );

    // cap the upcoming broadcasts list depending on the current date
    // unfortunately YT API doesn't provide a way to filter broadcasts by date
    upcomingBroadcasts = upcomingBroadcasts.filter(broadcast => {
      const timeRange = 1000 * 60 * 60 * 24;
      const maxDate = Date.now() + timeRange;
      const minDate = Date.now() - timeRange;
      const broadcastDate = new Date(broadcast.snippet.scheduledStartTime).valueOf();
      return broadcastDate > minDate && broadcastDate < maxDate;
    });

    return [...activeBroadcasts, ...upcomingBroadcasts];
  }

  private async fetchLiveStream(id: string): Promise<IYoutubeLiveStream> {
    const url = `${this.apiBase}/liveStreams?part=cdn,snippet,contentDetails&id=${id}`;
    return (await platformAuthorizedRequest<{ items: IYoutubeLiveStream[] }>('youtube', url))
      .items[0];
  }

  private async fetchBroadcast(
    id: string,
    fields = ['snippet', 'contentDetails', 'status'],
  ): Promise<IYoutubeLiveBroadcast> {
    const filter = `&id=${id}`;
    const query = `part=${fields.join(',')}${filter}&maxResults=1&access_token=${this.oauthToken}`;
    return (
      await platformAuthorizedRequest<IYoutubeCollection<IYoutubeLiveBroadcast>>(
        'youtube',
        `${this.apiBase}/liveBroadcasts?${query}`,
      )
    ).items[0];
  }

  get chatUrl() {
    const broadcastId = this.state.settings.broadcastId;
    if (!broadcastId) return '';
    const mode = this.customizationService.isDarkTheme ? 'night' : 'day';
    const youtubeDomain = mode === 'day' ? 'https://youtube.com' : 'https://gaming.youtube.com';
    return `${youtubeDomain}/live_chat?v=${broadcastId}&is_popout=1`;
  }

  openYoutubeEnable() {
    electron.remote.shell.openExternal('https://youtube.com/live_dashboard_splash');
  }

  openDashboard() {
    electron.remote.shell.openExternal(this.dashboardUrl);
  }

  get dashboardUrl(): string {
    return `https://studio.youtube.com/video/${this.state.settings.broadcastId}/livestreaming`;
  }

  get streamPageUrl() {
    const nightMode = this.customizationService.isDarkTheme ? 'night' : 'day';
    const youtubeDomain =
      nightMode === 'day' ? 'https://youtube.com' : 'https://gaming.youtube.com';
    return `${youtubeDomain}/watch?v=${this.state.settings.broadcastId}`;
  }

  @mutation()
  private SET_STREAM_ID(streamId: string) {
    this.state.streamId = streamId;
  }

  @mutation()
  private SET_CATEGORIES(categories: IYoutubeCategory[]) {
    this.state.categories = categories;
  }
}
