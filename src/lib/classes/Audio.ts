import { get, derived, writable, type Writable } from 'svelte/store';
import type {
	StereoSignal,
	AudioCoreStatus,
	Signal,
	RawAudioBuffer,
	SamplerOptions,
	DecodedTrackContainer,
	MusicContainer, SpeechContainer
} from 'src/typeDeclarations';

import { scrubbingSamplesPlayer, stereoOut, bufferProgress } from '$lib/audio/AudioFunctions';
import { Wait, channelExtensionFor, clipToRange } from '$lib/classes/Utils';
import {
	CablesPatch,
	PlaylistMusic,
	Decoding,
	Scrubbing
} from '$lib/stores/stores';
import WebRenderer from '@elemaudio/web-renderer';
import type { NodeRepr_t } from '@elemaudio/core';
import { el } from '@elemaudio/core';

// todo: set a sample rate constant prop

export class AudioCore {
	_core: WebRenderer | null;
	_silentCore: WebRenderer | null;
	protected _AudioCoreStatus: Writable<AudioCoreStatus>;
	protected _contextIsRunning: Writable<boolean>;
	protected _elemLoaded: Writable<boolean>;
	protected _audioContext: Writable<AudioContext>;
	protected _endNodes: Writable<any>;
	protected _masterVolume: Writable<number | Signal>;
	protected _currentTrackName: string;
	protected _currentVFSPath: string;
	protected _currentTrackDurationSeconds: number;
	protected _scrubbing: boolean;

	constructor() {
		this._core = this._silentCore = null;
		this._masterVolume = writable(1); // default master volume
		this._AudioCoreStatus = writable('loading');
		this._contextIsRunning = writable(false);
		this._elemLoaded = writable(false);
		this._audioContext = writable();
		this._endNodes = writable({
			mainCore: null,
			silentCore: null
		});
		// these below are dynamically set from store subscriptions
		this._currentVFSPath = '';
		this._currentTrackName = '';
		this._currentTrackDurationSeconds = 0;
		this._scrubbing = false;
	}

	subscribeToStores() {
		/**
		 * @description
		 *  Subscribers to update AudioCore with current track info
		 */
		PlaylistMusic.subscribe(($p) => (Audio._currentTrackName = $p.currentTrack.title));

		PlaylistMusic.subscribe(
			($p) => (Audio._currentVFSPath = $p.currentTrack.vfsPath)
		);

		PlaylistMusic.subscribe(
			($p) =>
				(Audio._currentTrackDurationSeconds = $p.currentTrack.duration
					? $p.currentTrack.duration
					: 0)
		);

		Scrubbing.subscribe(($Scrubbing) => {
			Audio._scrubbing = $Scrubbing;
		});
	}

	cleanup() {
		// not sure about this, sometimes causes context to stay suspended forever
		// Audio.suspend();
	}

	/**
	 * @description Initialise the Elementary audio engine asynchronously
	 * and store it in the Audio class as Audio.elemEndNode
	 */
	async init(ctx?: AudioContext): Promise<void> {
		/**
		 * @description Came up with the idea of using a second WebRenderer instance
		 * to handle  audio rate 'control' signals and emit side effects, without
		 * hitting the hardware outputs. Monitoring for impact hit on performance, but
		 * seems to be fine so far. Calling this 'Two-Webrenderers-and-a-microphone'
		 * pattern '💿💿🎤'
		 */
		Audio._core = new WebRenderer();
		Audio._silentCore = new WebRenderer();

		// Subscribe to Svelte stores outside of component
		Audio.subscribeToStores();

		// Choose a context to use
		if (ctx) {
			Audio.actx = ctx;
			console.log('Passing existing AudioContext');
		} else {
			console.log('No context!');
		}

		// Elementary connecting promise : Main Core
		Audio.elemEndNode = await Audio._core
			.initialize(Audio.actx, {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [2]
			})
			.then((node) => {
				Audio._elemLoaded.set(true);
				return node;
			});

		// Elementary connecting promise : Silent Core
		Audio.elemSilentNode = await Audio._silentCore
			.initialize(Audio.actx, {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [2]
			})
			.then((node) => {
				return node;
			});

		Audio.routeToCables();
		Audio.connectToDestination(Audio.elemEndNode); // connect the Elem end node to the destination

		/* ---- Event Driven Callbacks ----------------- */

		// BaseAudioContext state change callback
		Audio.actx.addEventListener('statechange', Audio.stateChangeHandler);

		// Elementary load callback
		Audio._core.on('load', () => {
			console.log('Main core loaded 🔊?', Audio.elemLoaded);
		});

		Audio._silentCore.on('load', () => {
			console.log('Silent core loaded');
		});

		// Elementary error reporting
		Audio._core.on('error', function (e) {
			console.error('🔇 ', e);
			//Audio.cleanup();
		});

		Audio._silentCore.on('error', function (e) {
			console.error('🔇 ', e);
			//Audio.cleanup();
		});

		// Elementary FFT callback
		Audio._core.on('fft', function (e) {
			// do something with the FFT data
			console.count('fft');
		});

		// Elementary meter callback
		Audio._core.on('meter', function (e) {
			// do something with the meter data
			console.count('meter');
		});

		// Elementary snapshot callback
		Audio._silentCore.on('snapshot', function (e) {
			PlaylistMusic.update(($pl) => {
				$pl.currentTrack.progress = clipToRange(e.data as number, 0, 1);
				return $pl;
			});
		});
	}

	/*---- Callback handlers ------------------------------*/
	private stateChangeHandler = () => {
		Audio._contextIsRunning.update(() => {
			return Audio.actx.state === 'running';
		});
		Audio._AudioCoreStatus.update(() => {
			return Audio.baseState;
		});
	};

	/*---- Implementations  ------------------------------*/
	/**
	 * @description Connect a node to the BaseAudioContext destination
	 */
	connectToDestination(node: AudioNode) {
		node.connect(Audio.actx.destination);
	}

	/**
	 *  @description Routing the Elementary graph into the Cables.gl visualiser
	 */
	routeToCables() {
		const cablesSend = new GainNode(Audio.actx, { gain: 10 }); // boost the send into Cables visualiser, never heard
		Audio.elemEndNode.connect(cablesSend);
		get(CablesPatch).getVar('CablesAnalyzerNodeInput').setValue(cablesSend);
	}

	/**
	 * @description Elementary Audio WebRenderer uses a virtual file system to reference audio files.
	 * https://www.elementary.audio/docs/packages/web-renderer#virtual-file-system
	 * Update the virtual file system using data loaded from a load() function.
	 *
	 * @param rawAudioBuffer
	 * will be decoded to audio buffer for VFS use
	 * @param playlistStore
	 * a Writable that holds titles and other data derived from the buffers
	 * @param core
	 * the Elementary core which will register and use the VFS dictionary entry
	 */
	
	async updateVFS(
		rawAudioBuffer: RawAudioBuffer,
		playlistStore: Writable<MusicContainer | SpeechContainer>,
		core: WebRenderer | null
	) {

		let vfsDictionaryEntry: any;

		this.decodeRawBuffer(rawAudioBuffer).then((decodedBuffer) => {
			let { decodedBuffer: decoded, title, vfsPath } = decodedBuffer;
			if (!decoded) {
				console.warn('Decoding skipped.');
				return;
			}
			// adds a channel extension to the path for each channel, the extension starts at 1 (not 0)
			for (let i = 0; i < decoded.numberOfChannels; i++) {
				vfsDictionaryEntry = {
					...vfsDictionaryEntry,
					[`${vfsPath + channelExtensionFor(i + 1)}`]: decoded.getChannelData(i)
				};
			}
			// update data in the passed store
			playlistStore.update(($pl) => {
				$pl.titles.push(title);
				return $pl;
			});
			// update the VFS in the passed Elementary core
			console.log('Updating VFS with', vfsDictionaryEntry);
			core?.updateVirtualFileSystem(vfsDictionaryEntry);
		});
	}

	/**
	 * @description Decodes the raw audio buffer into an AudioBuffer, asynchonously with guards
	 */

	async decodeRawBuffer(rawAudioBuffer: RawAudioBuffer): Promise<DecodedTrackContainer> {
		const stopwatch = Date.now();
		while (!rawAudioBuffer) await new Promise((resolve) => setTimeout(resolve, 100));
		const { body, header } = rawAudioBuffer;
		let decoded: AudioBuffer | null = null;
		// we need audio context in order to decode the audio data
		while (!Audio.actx || !body) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		try {
			decoded = await Audio.actx.decodeAudioData(body as ArrayBuffer);
		} catch (error) {
			console.log(new Error('Decoding skipped. Dummy buffer created.'));
			decoded = Audio.actx?.createBuffer(1, 1, 44100);
		} finally {
			header.bytes = decoded?.getChannelData(0).length || 0;
			console.log(
				'Decoded audio with length ',
				header.bytes,
				' to ',
				header.vfsPath,
				' in ',
				Date.now() - stopwatch,
				'ms'
			);
			Decoding.update(($d) => {
				$d.done = true;
				return $d;
			});
		}
		// update the DurationElement in the playlist container map
		if (decoded && decoded.duration > 1) {
			PlaylistMusic.update(($plist) => {
				// guard against the 1 samp skipped buffer hack above
				if (!decoded) return $plist;
				$plist.durations.set(header.title as string, decoded.duration);
				return $plist;
			});
		}
		return {
			title: header.title as string,
			vfsPath: header.vfsPath as string,
			decodedBuffer: decoded
		};
	}

	/**
	 * @description Wraps the Elementary core Render function
	 */
	render(stereoSignal: StereoSignal): void {
		if (!Audio._core || !stereoSignal) return;
		Audio.status = 'playing';
		const final = stereoOut(stereoSignal);
		Audio._core.render(final.left, final.right);
	}

	/**
	 * @description silent render of a control signal, for handling a signal with a side effect like the progress counter composite, which emits an event _and_ an audiorate signal
	 */
	controlRender(controlSignal: Signal): void {
		if (!Audio._silentCore || !controlSignal) return;
		Audio._silentCore.render(el.mul(controlSignal, 0));
	}

	/**
	 * @description: Plays samples from a VFS path, with scrubbing
	 */
	playWithScrubFromVFS(props: SamplerOptions) {
		Audio.render(scrubbingSamplesPlayer(props));
		Audio.progressBar({
			run: props.trigger as number,
			startOffset: props.startOffset || 0
		});
	}

	/**
	 * @description: Render the progress counter composite and its callback sideeffect
	 */
	progressBar(props: { run: number; startOffset: number }) {
		let { run = 1, startOffset: startOffsetMs = 0 } = props;
		let rate = 10;
		const totalDurMs = Audio.currentTrackDurationSeconds * 1000;
		Audio.controlRender(
			bufferProgress({
				key: Audio.currentTrackDurationSeconds + '_progBar',
				totalDurMs,
				run,
				rate,
				startOffset: startOffsetMs
			})
		);
	}

	/**
	 * @description: Tries to resume the base AudioContext
	 * this should only be called once, after a user interaction
	 */
	resumeContext(): void {
		if (Audio.status === 'resuming') return;
		if (Audio.actx.state === 'suspended') {
			Audio.status = 'resuming';
			Audio.actx.resume().then(() => {
				console.log('AudioContext resumed ⚙︎');
				Audio.status = 'running';
			});
		}
	}

	/**
	 * Unmute aka 'Play'
	 */
	unmute(): void {
		// try to resume the context if it's suspended
		if (Audio.status === 'suspended') {
			Audio.resumeContext();
		}
		// gate the current track
		Audio.playWithScrubFromVFS({
			vfsPath: Audio.currentVFSPath,
			trigger: 1
		});
	}

	/**
	 * @description
	 * Stop sounding but keep the audio context running
	 * , send a Mute message to Cables patch
	 */
	pause(pauseCables: boolean = false): void {
		// release gate on the current track

		Audio.playWithScrubFromVFS({
			vfsPath: Audio.currentVFSPath,
			trigger: 0
		});

		Audio.status = 'paused';
		if (pauseCables) Audio.pauseCables('pause');
	}

	// todo: pause or resume Cables patch
	pauseCables(state: 'pause' | 'resume'): void {}

	suspend(): void {
		Audio.actx.suspend().then(() => {
			console.log('🔇 audiocontext suspended');
		});
	}

	suspendAfterMs(ms: number = 100): void {
		new Promise((res) => setTimeout(res, ms)).then(() => {
			Audio.suspend();
		});
	}

	/*---- getters  --------------------------------*/
	get stores() {
		// todo: refactor these to Tan-Li Hau's subsciber pattern
		// https://www.youtube.com/watch?v=oiWgqk8zG18
		return {
			audioStatus: Audio._AudioCoreStatus,
			isRunning: Audio._contextIsRunning,
			actx: Audio._audioContext,
			endNodes: Audio._endNodes,
			masterVolume: Audio._masterVolume
		};
	}

	get scrubbing(): boolean {
		return Audio._scrubbing;
	}

	get currentTrackDurationSeconds(): number {
		return Audio._currentTrackDurationSeconds;
	}

	get currentVFSPath(): string {
		return Audio._currentVFSPath;
	}

	get audioBuffersReady(): boolean {
		return typeof Audio._currentTrackName === 'string';
	}
	get currentTrackTitle(): string {
		return Audio._currentTrackName;
	}

	get masterVolume(): number | NodeRepr_t {
		return get(Audio._masterVolume);
	}

	get contextAndStatus() {
		return derived([Audio._audioContext, Audio._AudioCoreStatus], ([$audioContext, $status]) => {
			return { context: $audioContext, status: $status };
		});
	}

	get actx() {
		return get(Audio.contextAndStatus).context;
	}

	get status() {
		console.log('get status', get(Audio._AudioCoreStatus));
		return get(Audio._AudioCoreStatus);
	}

	get elemLoaded() {
		return get(Audio._elemLoaded);
	}

	get isRunning(): boolean {
		return get(Audio._contextIsRunning);
	}

	get isMuted(): boolean {
		return Audio.status !== ('playing' || 'running') || !Audio.isRunning;
	}

	get elemSilentNode() {
		return get(Audio._endNodes).silentCore;
	}

	get elemEndNode() {
		return get(Audio._endNodes).mainCore;
	}

	get baseState(): AudioCoreStatus {
		return Audio.actx.state as AudioCoreStatus;
	}
	/*---- setters --------------------------------*/

	// set currentVFSPath(path: string) {
	// 	console.log('set currentVFSPath', path);
	// 	PlaylistMusic.update(($plist) => {
	// 		$plist.currentTrack.vfsPath = path;
	// 		return $plist;
	// 	});
	// }

	// set currentTrackTitle(title: string) {
	// 	PlaylistMusic.update(($plist) => {
	// 		$plist.currentTrack.title = title;
	// 		return $plist;
	// 	});
	// }

	set masterVolume(normLevel: number | NodeRepr_t) {
		Audio._masterVolume.update(() => normLevel);
	}

	set actx(newCtx: AudioContext) {
		Audio._audioContext.update(() => newCtx);
	}

	set status(newStatus: AudioCoreStatus) {
		Audio._AudioCoreStatus.update(() => newStatus);
	}
	set elemSilentNode(node: AudioNode) {
		Audio._endNodes.update((n) => {
			n.silentCore = node;
			return n;
		});
	}

	set elemEndNode(node: AudioNode) {
		Audio._endNodes.update((n) => {
			n.mainCore = node;
			return n;
		});
	}
}

export const Audio = new AudioCore();

