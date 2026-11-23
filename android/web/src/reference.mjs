export function referenceSupported(mode,model,managed){
 if(mode==='Chat')return model?.capabilities?.reference_image!==false;
 if(mode==='Image')return !!(managed&&model?.capabilities?.image_to_image);
 return managed?!!model?.capabilities?.reference_image:true;
}
export function referenceHint(mode,model,managed){
 if(mode==='Chat')return '';
 if(managed&&!model?.capabilities)return 'This connection does not advertise reference-image support. Update the manager or select a model that supports image-to-image.';
 if(referenceSupported(mode,model,managed))return mode==='Image'?'Reference image supported. Attach a photo to guide image-to-image generation.':'Reference image supported for image-to-video.';
 return mode==='Image'?'This connection does not advertise reference-image support. Update the manager or select a model that supports image-to-image.':'This video model supports text prompts only. Select Wan2.2 to use a reference image.';
}
