import MarkdownIt from './vendor/markdown-it.mjs';

const markdown = new MarkdownIt({html:false, breaks:true, linkify:false});
markdown.disable('image');
markdown.validateLink = url => /^(https?:\/\/|mailto:)/i.test(url);
const renderToken = markdown.renderer.rules.link_open ?? ((tokens,index,options,_env,renderer) =>
  renderer.renderToken(tokens,index,options));
markdown.renderer.rules.link_open = (tokens,index,options,env,renderer) => {
  tokens[index].attrSet('target','_blank');
  tokens[index].attrSet('rel','noopener noreferrer');
  return renderToken(tokens,index,options,env,renderer);
};
markdown.renderer.rules.table_open = () => '<div class="markdown-table" tabindex="0" role="region" aria-label="数据表"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';

export function renderMarkdown(text) {
  return markdown.render(String(text ?? ''));
}
