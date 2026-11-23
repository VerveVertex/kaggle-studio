import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import {normalizeMath} from './math.mjs';
const mathOptions={trust:false,strict:'ignore',throwOnError:false,maxExpand:300,maxSize:20};
export default function MathMarkdown({children}){return <Markdown remarkPlugins={[remarkGfm,remarkMath]} rehypePlugins={[[rehypeKatex,mathOptions]]}>{normalizeMath(children)}</Markdown>}
