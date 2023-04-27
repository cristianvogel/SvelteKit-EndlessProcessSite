// This file defines the stores used in the app

import { writable, type Readable, type Writable, readable } from 'svelte/store';
import type { SinglePost, RawFFT, PlaylistContainer, MetersContainer } from '../../typeDeclarations';
import { getMusicFiles, getSpeechFiles } from '$lib/classes/Files';

//---- UX / State related -------------------
export const LoadingSomething: Writable<{ state: boolean; count: number }> = writable({
	state: false,
	count: 0
});

export const Decoded: Writable<{ done: boolean; progress?: number }> = writable({
	done: false,
});

export const MusicCoreLoaded: Writable<boolean> = writable(false);
export const SpeechCoreLoaded: Writable<boolean> = writable(false);


//---- Blog related -------------------
// Todo: Implement sanitiser for the content
export const singlePost: Writable<SinglePost> = writable({
	title: '',
	content: { rawHTML: '', sanitisedHTML: '' },
	featuredImageURL: '',
	id: '',
	date: '',
	cardIndex: '',
	isOpen: false
});

//---- Cables related -------------------
export const CablesPatch: Writable<any> = writable('...loading...');
export const CablesAudioContext: Writable<AudioContext> = writable();
export const CablesIsLoaded: Writable<boolean> = writable(false);
export const CablesText: Writable<Array<string>> = writable(['Endless', 'Process']);

//---- Audio related -------------------

export const OutputMeters: Writable<MetersContainer> = writable(
	{
		MusicAudible: 0,
		MusicSilent: 0,
		SpeechAudible: 0,
		SpeechSilent: 0
	}
)

/**
 * @Important  path prefix used as key for the Virtual File System (VFS)
 */
export const VFS_PATH_PREFIX: Readable<string> = readable('vfs::');


//----------------- Music -----------------------
/** 
 * @todo: ID3, description, loaded flag
 */
export const PlaylistMusic: Writable<PlaylistContainer> = writable({
	audioAssetPaths: { music: getMusicFiles(), speech: getSpeechFiles() },
	titles: { music: new Array<string>(), speech: new Array<string>() },
	durations: new Map<string, number>(),
	show: false,
	currentTrack: {
		title: '',
		vfsPath: '',
		loaded: false,
		duration: 0,
		offset: 0,
		progress: 0
	},
	currentChapter: {
		progress: 0,
		title: '',
		vfsPath: '',
		duration: 0,
		offset: 0
	}
});
export type DurationsMapElement = { key: string; value: number };
export const PlaysCount: Writable<number> = writable(0);
export const Scrubbing: Writable<boolean> = writable(false);



//---------- deprecating zone -----------------------
// 🚮 

// probably not needed anymore, as sound output is all handled by the AudioCore now
export const EndNodes: Writable<any> = writable({ elem: null, cables: null });
export const rawFFT: Writable<RawFFT> = writable({
	real: new Float32Array(0),
	imag: new Float32Array(0)
});




// export const AUDIO_ASSETS_PREFIX: Readable<string> = readable('/audio/mp3');