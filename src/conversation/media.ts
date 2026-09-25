import { MediaError, type Media } from "../whatsapp/media.js";
import type { Turn } from "./context.js";
import * as copy from "./copy.js";
import { annotateInbound } from "./store.js";

/** Download a photo or voice note. Tells the person and returns null when that fails. */
export async function fetchMedia(t: Turn<unknown>, mediaId: string): Promise<Media | null> {
  try {
    return await t.svc.media.fetch(mediaId);
  } catch (err) {
    const tooLarge = err instanceof MediaError && err.reason === "too_large";
    t.svc.log.warn({ err: err instanceof Error ? err.message : String(err) }, "Could not download media");
    await t.reply(tooLarge ? copy.mediaTooLarge() : copy.mediaFailed());
    return null;
  }
}

/**
 * Turn a voice note into text. What we heard goes at the top of the next reply, so a wrong
 * transcript is easy to spot. Returns null (after telling the person) when there's no speech
 * service or nothing was heard.
 */
export async function hearVoiceNote(t: Turn<unknown>, mediaId: string, waMessageId = t.inbound.waMessageId): Promise<string | null> {
  const { svc } = t;
  if (!svc.speech) {
    await t.reply(copy.voiceNotYet());
    return null;
  }
  const audio = await fetchMedia(t, mediaId);
  if (!audio) return null;
  let text: string | undefined;
  let language: string | undefined;
  try {
    const transcript = await svc.speech.transcribe(audio);
    text = transcript?.text;
    language = transcript?.language;
  } catch (err) {
    svc.log.error({ err: err instanceof Error ? err.message : String(err) }, "Speech-to-text failed");
    await t.reply(copy.voiceFailed());
    return null;
  }
  if (!text) {
    await t.reply(copy.voiceEmpty());
    return null;
  }
  await annotateInbound(svc.db, waMessageId, { transcript: text, language });
  t.prefixNext(copy.heard(text));
  return text;
}
