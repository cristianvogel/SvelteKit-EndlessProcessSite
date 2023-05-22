import { OutputMeters, PlaylistMusic } from "$lib/stores/stores";
import { AudioMain } from "$lib/classes/Audio";
import { hannEnvelope } from "$lib/audio/AudioFunctions";
import type { MessageEvent, MeterEvent, EventExpressionsForNamedRenderer } from "../../typeDeclarations";

/**
 * EventExpressoions are functions that are called when an event is received 
 * from an Elementary audio renderer instance via the Event emitting interface of 
 * that instance.
 * At v2.0.0 a standard core fires 
 * el.meter, el.snapshot, el.fft, el.scope
 */

const eventExpressions: EventExpressionsForNamedRenderer = new Map()

const speechRenderer = {
    meter(e: MeterEvent) {
        OutputMeters.update(($o) => {
            const absMax = Math.max(e.max, Math.abs(e.min));
            $o = { ...$o, SpeechAudible: absMax };
            return $o
        })
    }
}

const silentRenderer = {
    snapshot(e: MessageEvent) {
        switch (e.source) {
            case 'progress':
                AudioMain.updateOutputLevelWith(hannEnvelope(AudioMain.progress));
                PlaylistMusic.update(($pl) => {
                    if (!$pl.currentTrack || !e.data) return $pl;
                    $pl.currentTrack.progress = e.data as number;
                    return $pl
                });
                break
            default:
                console.log('silentRenderer received snapshot from source: ', e.source, e.data);
        }
    }
}

eventExpressions.set('music', {})
eventExpressions.set('speech', speechRenderer)
eventExpressions.set('silent', silentRenderer)

export default eventExpressions