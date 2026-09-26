const labels: Record<string, string> = {
  'text.replace': 'Edit text', 'text.style': 'Format selected text', 'text.insert': 'Insert text', 'text.reflow': 'Reflow selected text',
  'image.insert': 'Insert image', 'image.replace': 'Replace selected image', 'image.crop': 'Crop selected image to box',
  'content.insert': 'Insert PDF content', 'pages.insert': 'Add blank page', 'pages.duplicate': 'Duplicate page',
  'pages.import': 'Import PDF pages', 'pages.rotate': 'Rotate page', 'pages.crop': 'Crop page to box',
  'pages.delete': 'Delete page', 'pages.reorder': 'Organize pages', 'pages.decorate': 'Page numbers & watermark',
  'objects.transform': 'Arrange objects', 'objects.align': 'Align', 'objects.distribute': 'Distribute selected objects',
  'objects.copy': 'Duplicate', 'objects.delete': 'Delete', 'objects.group': 'Group', 'objects.ungroup': 'Ungroup',
  'annotation.add': 'Add note', 'annotation.update': 'Update selected annotation', 'annotation.delete': 'Delete',
  'form.create': 'Create field', 'form.fill': 'Fill forms', 'form.update': 'Apply field properties',
};

export const commandLabel = (type: string) => labels[type] ?? 'Edit';
