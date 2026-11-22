// The static Pages build supplies the public HTTPS origin. A self-hosted copy
// serves both the UI and the API on the same origin.
const origin=document.querySelector('meta[name="workspace-api-origin"]')?.content || location.origin;
export function apiUrl(path){
  return new URL(path,origin).href;
}
