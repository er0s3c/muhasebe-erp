"""Synthetic local acceptance fixtures; no customer or licensed design data."""
from pathlib import Path
import pymupdf
import ifcopenshell
import ifcopenshell.api
import numpy as np
root = Path(__file__).parent
doc = pymupdf.open()
page = doc.new_page(width=600, height=500)
page.insert_text((40,40), "A-01 / Rev 01 - Synthetic floor plan", fontsize=18)
page.draw_rect(pymupdf.Rect(80,90,510,410), color=(.1,.1,.1), width=4)
page.draw_line(pymupdf.Point(300,90),pymupdf.Point(300,410),color=(.1,.1,.1),width=3)
page.insert_text((100,250),"Zone A - 5 m",fontsize=18)
page.insert_text((330,250),"Zone B",fontsize=18)
doc.save(root / "plan.pdf")
invoice = pymupdf.open()
p = invoice.new_page(width=600,height=420)
p.insert_text((40,60),"Synthetic supplier invoice",fontsize=26)
p.insert_text((40,115),"Fatura No: TEST2026000001",fontsize=24)
p.insert_text((40,165),"Date: 06.10.2026",fontsize=24)
p.insert_text((40,215),"Currency: TRY",fontsize=24)
p.insert_text((40,265),"Concrete 10 m3",fontsize=24)
p.insert_text((40,325),"Grand Total: 999.99",fontsize=28)
invoice.save(root / "invoice.pdf")
p.get_pixmap(matrix=pymupdf.Matrix(2,2)).save(root / "invoice.png")
scanned = pymupdf.open()
scanpage = scanned.new_page(width=600,height=420)
scanpage.insert_image(scanpage.rect,filename=str(root / "invoice.png"))
scanned.save(root / "invoice-scanned.pdf")
model=ifcopenshell.api.run("project.create_file",version="IFC4")
project=ifcopenshell.api.run("root.create_entity",model,ifc_class="IfcProject",name="Synthetic acceptance project")
ifcopenshell.api.run("unit.assign_unit",model)
context=ifcopenshell.api.run("context.add_context",model,context_type="Model")
body=ifcopenshell.api.run("context.add_context",model,context_type="Model",context_identifier="Body",target_view="MODEL_VIEW",parent=context)
site=ifcopenshell.api.run("root.create_entity",model,ifc_class="IfcSite",name="Site")
building=ifcopenshell.api.run("root.create_entity",model,ifc_class="IfcBuilding",name="A Block")
storey=ifcopenshell.api.run("root.create_entity",model,ifc_class="IfcBuildingStorey",name="Ground floor")
for parent,child in [(project,site),(site,building),(building,storey)]:
    ifcopenshell.api.run("aggregate.assign_object",model,relating_object=parent,products=[child])
for i in range(2):
    wall=ifcopenshell.api.run("root.create_entity",model,ifc_class="IfcWall",name=f"Acceptance wall {i+1}")
    representation=ifcopenshell.api.run("geometry.add_wall_representation",model,context=body,length=5,height=3,thickness=.2)
    ifcopenshell.api.run("geometry.assign_representation",model,product=wall,representation=representation)
    matrix=np.eye(4);matrix[1,3]=i*4
    ifcopenshell.api.run("geometry.edit_object_placement",model,product=wall,matrix=matrix)
    ifcopenshell.api.run("spatial.assign_container",model,relating_structure=storey,products=[wall])
model.write(str(root / "model.ifc"))
