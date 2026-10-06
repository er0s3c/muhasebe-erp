"""Local, bounded IFC tessellation and PDF text/raster extraction. No network access."""
import json, os, sys

kind, source, destination = sys.argv[1:4]
if kind == "ifc":
    import ifcopenshell
    import ifcopenshell.geom
    import ifcopenshell.util.element
    model = ifcopenshell.open(source)
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    iterator = ifcopenshell.geom.iterator(settings, model, min(os.cpu_count() or 1, 4))
    elements, warnings, vertices = [], [], 0
    if not iterator.initialize():
        raise ValueError("IFC modelinde işlenebilir geometri bulunamadı.")
    while True:
        shape = iterator.get()
        product = model.by_id(shape.id)
        container = ifcopenshell.util.element.get_container(product)
        verts, faces = list(shape.geometry.verts), list(shape.geometry.faces)
        vertices += len(verts)
        if vertices > 6_000_000 or len(elements) >= 20_000:
            raise ValueError("Model ilk sürümün geometri sınırını aşıyor; katlara bölerek yükleyin.")
        if faces and verts:
            elements.append({"guid": product.GlobalId, "name": product.Name or product.is_a(), "type": product.is_a(), "storey": container.Name if container else "Kat belirtilmemiş", "vertices": verts, "faces": faces})
        if not iterator.next():
            break
    represented = [p for p in model.by_type("IfcProduct") if getattr(p, "Representation", None)]
    if len(represented) > len(elements):
        warnings.append(f"{len(represented)-len(elements)} nesne geometri üretmedi; kaynak modeli kontrol edin.")
    result = {"elements": elements, "warnings": warnings, "schema": model.schema}
elif kind == "pdf":
    import pypdfium2 as pdfium
    try:
        doc = pdfium.PdfDocument(source)
    except pdfium.PdfiumError as exc:
        raise ValueError("PDF açılamadı; dosya hatalı veya parola korumalı.") from exc
    if len(doc) > 20:
        raise ValueError("OCR için en fazla 20 sayfalık belge yükleyin.")
    texts, images = [], []
    for i, page in enumerate(doc):
        textpage = page.get_textpage()
        text = textpage.get_text_range().strip()
        textpage.close()
        if len(text) >= 30:
            texts.append(text)
        else:
            image = os.path.join(os.path.dirname(destination), f"page-{i}.png")
            # Bounded raster size, including pathological page dimensions.
            scale = min(2, 2500 / max(page.get_size()))
            bitmap = page.render(scale=scale)
            bitmap.to_pil().save(image)
            bitmap.close()
            images.append(image)
        page.close()
    result = {"text": "\n\n".join(texts), "images": images, "pages": len(doc)}
    doc.close()
else:
    raise ValueError("Desteklenmeyen yerel işlem.")
with open(destination, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
