export const MAX_CHAT_BYTES=7*1024*1024;
const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
export function estimateTokens(content){if(Array.isArray(content))return content.reduce((n,p)=>n+(p.type==='image_url'?2048:estimateTokens(p.text||'')),0);let ascii=0,other=0;for(const c of String(content)){if(c.codePointAt(0)<128)ascii++;else other++}return Math.ceil(ascii/3+other*1.5)+8}
export function budgetConversation(messages,context=65536){
 const capacity=Math.max(1024,(Number(context)||65536)-8192),last=messages.at(-1);if(!last)throw Error('Enter a message.');
 if(estimateTokens(last.content)>capacity)throw Error('This question exceeds the current context budget. Choose 128K / 256K or split the question. Your full question remains in chat history.');
 if(size([last])>MAX_CHAT_BYTES)throw Error('This question and its images exceed 7 MB. Reduce image size or split the question.');
 let tokens=estimateTokens(last.content),result=[last],bytes=size(result);
 // Keep complete recent user/assistant exchanges, never cut or silently shorten the current question.
 for(let end=messages.length-1;end>0;){let start=end-1;while(start>0&&messages[start].role!=='user')start--;const group=messages.slice(start,end);const cost=group.reduce((n,m)=>n+estimateTokens(m.content),0),addedBytes=size(group)-1;if(group.length+result.length>1000||tokens+cost>capacity||bytes+addedBytes>MAX_CHAT_BYTES)break;result=[...group,...result];tokens+=cost;bytes+=addedBytes;end=start;}
 return {messages:result,omitted:messages.length-result.length,estimatedTokens:tokens};
}
