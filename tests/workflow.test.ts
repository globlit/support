import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextReview} from '../src/workflow.js';
import type {LiveDetail,ChangeSet} from '../src/model.js';
const detail={issue:{resolved:false},session:{plans:[],approval:null}} as unknown as LiveDetail;
const change={createdAt:'2026-11-07',state:'review',message:'Check status'} as ChangeSet;
test('next action follows plan review and does not treat approval as execution',()=>{
 assert.equal(nextReview(detail,[]).stage,0);
 const planned={...detail,session:{...detail.session,plans:[{version:1,text:'Plan',at:''}]}};
 assert.equal(nextReview(planned,[]).title,'Review the proposed plan');
 const approved={...planned,session:{...planned.session,approval:{version:1} as NonNullable<LiveDetail['session']['approval']>}};
 assert.equal(nextReview(approved,[]).title,'Choose the change scope');
 assert.equal(nextReview({...approved,session:{...approved.session,pendingRevision:true}},[]).title,'Revision requested');
});
test('code and message reviews follow actual records, not plan completion',()=>{
 assert.equal(nextReview(detail,[change]).title,'Review the code and MR message');
 assert.equal(nextReview(detail,[{...change,state:'branch_pending'}]).title,'Changes need attention');
 const mr={...change,mr:{iid:1,url:'https://git.local/mr/1'}};
 assert.equal(nextReview(detail,[mr]).stage,3);
 assert.equal(nextReview(detail,[{...mr,fixes:[{state:'proposed'}] as ChangeSet['fixes']}]).title,'Review the proposed fix');
 assert.equal(nextReview(detail,[{...mr,resolution:{state:'draft'} as ChangeSet['resolution']}]).title,'Review the resolution message');
 assert.equal(nextReview(detail,[{...mr,resolution:{state:'posted'} as ChangeSet['resolution']}]).title,'Review ticket closure');
 assert.equal(nextReview({...detail,issue:{...detail.issue,resolved:true}},[mr]).stage,5);
});
