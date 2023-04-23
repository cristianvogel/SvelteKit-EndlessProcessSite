import type { AudioCoreStatus, DecodedTrackContainer, ArrayBufferContainer, StereoSignal, Signal } from '../../typeDeclarations';
import { get } from 'svelte/store';
import WebRenderer from '@elemaudio/web-renderer';
import { writable, type Writable } from 'svelte/store';
import { AudioCore } from '$lib/classes/Audio';
import { load } from '$lib/classes/IngestorSpeechFiles';
import { OutputMeters, PlaylistSpeech, VFS_PATH_PREFIX } from '$lib/stores/stores';
import { meter, stereoOut } from '$lib/audio/AudioFunctions';
import { el, type NodeRepr_t } from '@elemaudio/core';

// ════════╡ Voice ╞═══════
// todo: add a way to set the voice's position in the audio file
// todo: add a way to set the voice's start offset in the audio file
// 🚨 this is still a demo/test and not a full implementation

export class VoiceCore extends AudioCore {
	_core: WebRenderer | null;
	_silentVoiceCore: WebRenderer | null;
	_voiceCoreStatus: Writable<AudioCoreStatus>;
	_currentVFSPath: string;
	_currentChapterID: string;
	_currentChapterDurationSeconds: number;
	_scrubbing: boolean;
	_currentChapterName: string;
	_sidechain: number;

	constructor() {
		super();
		this._core = this._silentVoiceCore = null;
		this._voiceCoreStatus = writable('loading');
		this._endNodes = writable({
			mainCore: null,
			silentCore: null
		});

		// these below are dynamically set from store subscriptions
		this._currentVFSPath = '';
		this._currentChapterID = '';
		this._currentChapterName = '';
		this._currentChapterDurationSeconds = 0;
		this._scrubbing = false;
		this._sidechain = 0;
	}

	subscribeToStores(): void {
		OutputMeters.subscribe(($meters) => {
			this._sidechain = $meters['MusicAudible'] || 0;
		});
	}

	async init(): Promise<void> {
		VoiceOver._core = new WebRenderer();
		VoiceOver._silentVoiceCore = new WebRenderer();
		VoiceOver.subscribeToStores();

		/** 
		 * @description: load the speech buffers from the VFS
		 * for the music buffers, this is done in the +layout.ts file
		 * @todo: refactor this to be done in the same place?
		 */

		load({ fetch }).then((buffersContainer: any) => {
			console.log('speech buffers', buffersContainer);
			this.parallelDecoder(buffersContainer.buffers);
		});

		while (!super.actx) {
			console.log('Waiting for first WebRenderer instance to load...');
			await new Promise((resolve) => setTimeout(resolve, 100));
		}


		// initialise the voice cores
		VoiceOver.voiceEndNode = await VoiceOver._core
			.initialize(super.actx, {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [2]
			})
			.then((node) => {
				return node;
			});

		VoiceOver.silentVoiceEndNode = await VoiceOver._silentVoiceCore
			.initialize(super.actx, {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [2]
			})
			.then((node) => {
				console.log('Silent Voice Core loaded  🎤');
				return node;
			});

		VoiceOver._core.on('error', function (e) {
			console.error('🔇 ', e);
		});
		VoiceOver._silentVoiceCore.on('error', function (e) {
			console.error('🔇 ', e);
		});

		VoiceOver._core.on('meter', function (e) {
			OutputMeters.update(($o) => {
				$o = { ...$o, SpeechAudible: e.max };
				return $o;
			})
		})

		VoiceOver._core.on('load', () => {
			console.log('Voice Core loaded  🎤');
			VoiceOver.status = 'ready';
		});

		super.connectToDestination(VoiceOver.voiceEndNode);
	}

	/**
	 * @todo inherit decodeRawBuffer() from super
	 */

	async decodeRawBuffer(rawAudioBuffer: ArrayBufferContainer): Promise<DecodedTrackContainer> {
		const stopwatch = Date.now();
		while (!rawAudioBuffer) await new Promise((resolve) => setTimeout(resolve, 100));
		const { body, header } = rawAudioBuffer;
		let decoded: AudioBuffer | null = null;
		// we need audio context in order to decode the audio data
		while (!super.actx || !body) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		try {
			decoded = await super.actx.decodeAudioData(body as ArrayBuffer);
		} catch (error) {
			console.log(new Error('Decoding skipped. Dummy buffer created.'));
			decoded = super.actx?.createBuffer(1, 1, 44100);
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
		}
		// update the DurationElement in the playlist container map
		if (decoded && decoded.duration > 1) {
			PlaylistSpeech.update(($plist) => {
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
	 * @description
	 * Parallel Assets Worker
	 * see ./src/+page.svelte
	 * @todo abstract out the parallel decoder
	 */

	parallelDecoder(buffers: any) {
		let parallel: Array<any> = [];
		Promise.all(buffers).then((resolved) => {
			for (let i = 0; i < resolved.length; i++) {
				const track: ArrayBufferContainer = resolved[i];

				const vfsPath = get(VFS_PATH_PREFIX) + track.header.title;
				const header = { ...track.header, vfsPath };
				parallel.push(async () => {
					const decoded: ArrayBuffer = await track.body;
					return super.updateVFS({
						header,
						body: decoded,
					}, PlaylistSpeech, VoiceOver);
				});
			}

			Promise.all(parallel.map((func) => func())).then(() =>
				console.log('SPEECH: Parallel promises resolved')
			);
		});
	}

	/**
	 * @description hacky version of a mono 2 stereo
	 * @todo inherit playFromVFS() & render() from super
	 * @todo this is soundhacky for fun, will need refining into Memoised audio functions
	 */
	playFromVFS(gate: Number = 1): void {

		const test = get(PlaylistSpeech).currentChapter.vfsPath;
		console.log('playFromVFS speech->', test);

		const lr =
			[
				el.sample({ path: test, mode: 'gate' },
					gate as number,
					el.const({ key: 'rateL', value: 0.9 })),

				el.sample({ path: test, mode: 'gate' },
					gate as number,
					el.const({ key: 'rateR', value: 0.901 }))
			];

		VoiceOver.render({
			left:
				lr[0],
			right:
				lr[1]
		});
	}

	render(stereoSignal: StereoSignal): void {
		if (!VoiceOver._core || !stereoSignal) return;
		VoiceOver.status = 'playing';
		const final = stereoOut(stereoSignal);
		VoiceOver._core.render(final.left, final.right);
		VoiceOver._core?.render(meter(final));
	}

	/*---- getters --------------------------------*/

	get sidechain() {
		return this._sidechain;
	}
	get voiceEndNode() {
		return get(this._endNodes).mainCore;
	}

	/*---- setters --------------------------------*/

	set status(status: AudioCoreStatus) {
		this._voiceCoreStatus.update((s) => {
			return status;
		});
	}

	set voiceEndNode(node: AudioNode) {
		this._endNodes.update((endNodes) => {
			endNodes.mainCore = node;
			return endNodes;
		});
	}

	set silentVoiceEndNode(node: AudioNode) {
		this._endNodes.update((endNodes) => {
			endNodes.silentCore = node;
			return endNodes;
		});
	}
}

export const VoiceOver = new VoiceCore();
