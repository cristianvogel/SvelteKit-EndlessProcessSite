import { get, derived, writable, type Writable } from 'svelte/store';
import type {
	StereoSignal,
	AudioCoreStatus,
	Signal,
	SamplerOptions,
	StructuredAssetContainer
} from '../../typeDeclarations';

import { scrubbingSamplesPlayer, stereoOut, bufferProgress } from '$lib/audio/AudioFunctions';
import { channelExtensionFor, clipToRange, processEachChannel } from '$lib/classes/Utils';
import {
	CablesPatch,
	PlaylistMusic,
	Decoded,
	Scrubbing,
	OutputMeters,
	MusicCoreLoaded,
	VFS_PATH_PREFIX
} from '$lib/stores/stores';
import WebRenderer from '@elemaudio/web-renderer';
import type { NodeRepr_t } from '@elemaudio/core';
import { el } from '@elemaudio/core';


// todo: set a sample rate constant prop

export class AudioCore {
	_core: WebRenderer | null;
	_silentCore: WebRenderer | null;
	_AudioCoreStatus: Writable<AudioCoreStatus>;
	_contextIsRunning: Writable<boolean>;
	_audioContext: Writable<AudioContext>;
	_endNodes: Writable<any>;
	_masterVolume: Writable<number | Signal>;
	_currentTrackName: string;
	_currentVFSPath: string;
	_currentTrackDurationSeconds: number;
	_scrubbing: boolean;
	_sidechain: number | Signal;
	_out: StereoSignal



	constructor() {
		this._core = this._silentCore = null;
		this._masterVolume = writable(0.5); // default master volume
		this._AudioCoreStatus = writable('loading');
		this._contextIsRunning = writable(false);
		this._audioContext = writable();
		this._endNodes = writable({
			mainCore: null,
			silentCore: null
		});
		this._out = { left: 0 as unknown as Signal, right: 0 as unknown as Signal };

		// these below are dynamically set from store subscriptions
		this._currentVFSPath = '';
		this._currentTrackName = '';
		this._currentTrackDurationSeconds = 0;
		this._scrubbing = false;
		this._sidechain = 0
	}

	subscribeToStores() {
		/**
		 * @description
		*  Subscribers that update the Audio class 's intertnal statem from outside
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

		OutputMeters.subscribe(($meters) => {
			if (!Audio._core) return;
			Audio._sidechain = el.sm($meters.SpeechAudible as number) as Signal;
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
		 * @name SignalComputation
		 * @info The 'silent core' signal computer harnesses a second 
		 * WebRenderer instance to compute at audio rate
		 * and emit event based on results, without the 
		 * unwanted side effect of outputting DC to speakers 
		 */
		Audio._core = new WebRenderer();
		Audio._silentCore = new WebRenderer();

		// this is the one AudioContext to use throughout
		if (ctx) {
			Audio.actx = ctx;
			console.log('Passing existing AudioContext');
		} else {
			console.log('No context!');
		}

		// Elementary Node : Main Core
		Audio.elemEndNode = await Audio._core
			.initialize(Audio.actx, {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [2]
			})
			.then((node) => {
				return node;
			});

		// Elementary Node : Silent Core
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
		Audio.connectToDestination(Audio.elemEndNode);

		/* ---- Event Driven Callbacks ----------------- */

		Audio.actx.addEventListener('statechange', Audio.stateChangeHandler);

		Audio._core.on('load', () => {
			MusicCoreLoaded.set(true)
			// Subscribe to Svelte stores outside of component
			Audio.subscribeToStores();
			console.log('Main core loaded 🔊');
		});

		Audio._silentCore.on('load', () => {
			console.log('Silent core loaded');
		});

		Audio._core.on('error', function (e) {
			console.error('🔇 ', e);
			//Audio.cleanup();
		});

		Audio._silentCore.on('error', function (e) {
			console.error('🔇 ', e);
			//Audio.cleanup();
		});

		Audio._core.on('fft', function (e) {
			// do something with the FFT data
			console.count('fft');
		});

		Audio._core.on('meter', function (e) {
			console.log('meter received in main core ', e.max);
			OutputMeters.update(($o) => {
				$o = { ...$o, MusicAudible: e.max }
				return $o;
			})
		});

		Audio._silentCore.on('snapshot', function (e) {
			PlaylistMusic.update(($pl) => {
				$pl.currentTrack.progress = clipToRange(e.data as number, 0, 1);
				return $pl;
			});
		});
	}

	/**
	 * @description Connect a node to the BaseAudioContext destination
	  */
	connectToDestination(node: AudioNode) {
		node.connect(Audio.actx.destination);
	}

	connectToMain(node: AudioNode) {
		node.connect(Audio.elemEndNode);
	}

	/**
	 *  @description Routing the Elementary graph into the Cables.gl visualiser
	 */
	routeToCables() {
		const cablesSend = new GainNode(Audio.actx, { gain: 10 }); // boost the send into Cables visualiser, never heard
		Audio.elemEndNode.connect(cablesSend);
		get(CablesPatch).getVar('CablesAnalyzerNodeInput').setValue(cablesSend);
	}

	private stateChangeHandler = () => {
		Audio._contextIsRunning.update(() => {
			return Audio.actx.state === 'running';
		});
		Audio._AudioCoreStatus.update(() => {
			return Audio.baseState;
		});
	};

	/**
	* @description Wraps the Elementary core Render function
	 */
	render(stereoSignal?: StereoSignal, key?: string): void {
		if (!Audio._core) return;
		if (stereoSignal) {
			Audio._out = stereoOut(stereoSignal);
		}

		const stereoComp = {
			left: el.compress(20, 160, -35, 90, el.in({ channel: 0 }), Audio._out.left),
			right: el.compress(20, 160, -35, 90, el.in({ channel: 0 }), Audio._out.right)
		}
		Audio.status = 'playing';
		Audio._core.render(stereoComp.left, stereoComp.right);
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
	 * @description Elementary Audio WebRenderer uses a virtual file system to reference audio files.
	 * https://www.elementary.audio/docs/packages/web-renderer#virtual-file-system
	 * Update the virtual file system using data loaded from a load() function.
	 *
	 * @param container
	 * header and body ArrayBufferContainer - will be decoded to audio buffer for VFS use
	 * @param playlistStore
	 * a Writable that holds titles and other data derived from the buffers
	 * @param core
	 * the Elementary core which will register and use the VFS dictionary entry.
	 * 🚨 Guard against race conditions by only updating the VFS when the core is loaded.
	 */

	async updateVFS(
		container: StructuredAssetContainer,
		core: WebRenderer | null
	) {
		// decoder
		Audio.decodeRawBuffer(container).then((data) => {
			let { decodedBuffer: decoded, title } = data;
			if (!decoded || decoded.length < 16) {
				console.warn('Decoding skipped.');
				return;
			}

			// update the DurationElement in the playlist container map
			PlaylistMusic.update(($plist) => {
				if (!decoded) return $plist;
				$plist.durations.set(title as string, decoded.duration);
				return $plist;
			});

			// adds a channel extension to the path for each channel, the extension starts at 1 (not 0)
			for (let i = 0; i < decoded.numberOfChannels; i++) {

				const vfsKey = get(VFS_PATH_PREFIX) + title + channelExtensionFor(i + 1);
				const vfsDictionaryEntry =
				{
					[vfsKey]: decoded.getChannelData(i)
				};
				core?.updateVirtualFileSystem(vfsDictionaryEntry);
			}
		});
	}

	/**
	 * @description Decodes the raw audio buffer into an AudioBuffer, asynchonously with guards
	 */
	async decodeRawBuffer(container: StructuredAssetContainer): Promise<{ title: string, vfsPath: string, decodedBuffer: AudioBuffer }> {

		//const storeDestination = core.
		const stopwatch = Date.now();
		while (!container) await new Promise((resolve) => setTimeout(resolve, 100));

		const { body, header } = container;

		let decoded: AudioBuffer | null = null;
		// we need audio context in order to decode the audio data
		while (!Audio.actx) {
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
				get(VFS_PATH_PREFIX) + header.title,
				' in ',
				Date.now() - stopwatch,
				'ms'
			);
			Decoded.update(($d) => {
				$d.done = true;
				return $d;
			});
		}

		return {
			title: header.title as string,
			vfsPath: header.vfsPath as string,
			decodedBuffer: decoded
		};
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
	pauseCables(state: 'pause' | 'resume'): void { }

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
	get sidechain() {
		return this._sidechain;
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
		return get(MusicCoreLoaded);
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

