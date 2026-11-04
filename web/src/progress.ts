type OutputChunk = {sequence:number; stream:string; text:string};
// Carriage-return progress is a history in this viewer, not a terminal overwrite.
// The underlying chunks and downloadable output are never modified.
export function progressOutput(chunks:OutputChunk[]) {
  let carriageReturn = false;
  const display = chunks.map(chunk => {
    let text = '';
    for (const character of chunk.text) {
      if (character === '\r') {text += '\n';carriageReturn=true;}
      else if (character === '\n' && carriageReturn) {carriageReturn=false;}
      else {text += character;carriageReturn=false;}
    }
    return {...chunk,text};
  });
  const raw = chunks.filter(chunk=>chunk.stream!=='system').map(chunk=>chunk.text).join('').replace(/\0|\x08/g,'');
  const percentages = [...raw.matchAll(/(?:^|[^\d.])(\d{1,3}(?:\.\d+)?)\s*%/g)];
  const value = percentages.length ? Number(percentages.at(-1)![1]) : null;
  return { display, percent: value!==null && value>=0 && value<=100 ? value : null };
}
