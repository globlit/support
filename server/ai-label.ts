/** Words frequent in French and rare in English, used to pick the label language. */
const frenchWords=/\b(le|la|les|des|une|est|pas|pour|avec|dans|sur|nous|vous|tu|ton|ta|tes|votre|merci|bonjour|ce|cette|qui|que|été|déjà|où)\b/gi;
const englishWords=/\b(the|is|are|was|not|for|with|this|that|you|your|we|our|thanks|hello|please|have|has|been|which|what)\b/gi;
/** Returns "fr" when the text reads as French, otherwise "en". */
export function textLanguage(text:string):'fr'|'en'{return (text.match(frenchWords)?.length??0)>(text.match(englishWords)?.length??0)?'fr':'en';}

/** Label that identifies text written by the agent, in the language of the text. */
export function aiLabel(text:string){
 return textLanguage(text)==='fr'?'[CLAUDE] Texte généré par IA, relu et validé par un ingénieur support avant envoi.':'[CLAUDE] AI-generated text, reviewed and approved by a support engineer before sending.';
}
/**
 * Returns `text` preceded by the AI label, as Markdown (italic) or as Slack text (plain, in its own line). Text that
 * already starts with a label is returned unchanged, so applying it twice adds nothing.
 */
export function withAiLabel(text:string,format:'markdown'|'slack'='markdown'){
 if(/^\s*[*_]?\[CLAUDE\]/.test(text))return text;
 const label=aiLabel(text);
 return `${format==='markdown'?`*${label}*`:`_${label}_`}\n\n${text}`;
}
