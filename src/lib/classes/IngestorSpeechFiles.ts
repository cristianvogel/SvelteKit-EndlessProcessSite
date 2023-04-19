/**
 * Audio file ingestor  -- SPEECH
 *
 * todo: Load from folder ( using hard coded path for now)
 * todo: decode buffers
 */

import { get } from 'svelte/store';
import { AUDIO_ASSETS_PREFIX, PlaylistSpeech, VFS_PATH_PREFIX } from '$lib/stores/stores';
import type { VoiceContainer, RawAudioBuffer } from 'src/typeDeclarations.js';
import { error } from '@sveltejs/kit';

const sourceURL_prefix = get(AUDIO_ASSETS_PREFIX) + '/speech/';
let playlist: Array<string>;

const unsubscribe = PlaylistSpeech.subscribe((container: VoiceContainer) => {
	playlist = container.playlist;
});

const target = (entry: string, i: number): string => `${entry}`;

export async function load({ fetch }) {
	let responses: Array<any> = [];
	let rawAudioBuffers: Array<Promise<any>> = [];

	for (let i = 0; i < playlist.length; i++) {
		const entry = playlist[i];
		const loadFrom: string = target(entry, i);
		console.log('Fetching ', loadFrom);
		const stopwatch = Date.now();
		responses.push(await fetch(loadFrom));
		console.log(' in ', Date.now() - stopwatch, 'ms');
	}

	for (let i = 0; i < responses.length; i++) {
		const response = responses[i];

		const rawArrayBuffer = async () => {
			return await response.arrayBuffer();
		};

		if (response.ok) {
			const name = playlist[i].replace(get(AUDIO_ASSETS_PREFIX), '::voice::');
			const structuredAudioBuffer: RawAudioBuffer = {
				header: {
					name,
					bytes: 0,
					vfsPath: get(VFS_PATH_PREFIX) + name
				},
				body: rawArrayBuffer()
			};
			const wrap = async () => {
				return structuredAudioBuffer;
			};
			rawAudioBuffers.push(wrap());
		} else {
			console.log('ArrayBuffer fetch failed 😿');
			throw error(404);
		}
	}
	unsubscribe();
	return { buffers: rawAudioBuffers };
}
