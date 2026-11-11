import test from 'node:test';
import assert from 'node:assert/strict';
import {withAiLabel,textLanguage} from '../server/ai-label.js';

test('agent text sent outside Support starts with an AI label in the language of the text',()=>{
 assert.equal(textLanguage('Bonjour, le pod est redémarré et la NetworkPolicy est corrigée pour vous.'),'fr');
 assert.equal(textLanguage('Hello, the pod was restarted and the policy is fixed for you.'),'en');
 const fr=withAiLabel('Salut, tu peux vérifier que le service répond ?');
 assert.match(fr,/^\*\[CLAUDE\] Texte généré par IA, relu et validé par un ingénieur support avant envoi\.\*\n\nSalut/);
 assert.match(withAiLabel('Please check the service.','slack'),/^_\[CLAUDE\] AI-generated text, reviewed and approved by a support engineer before sending\._\n\nPlease/);
 assert.equal(withAiLabel(fr),fr,'a labelled text is not labelled twice');
});
