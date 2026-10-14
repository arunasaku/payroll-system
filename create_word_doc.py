import os
import docx
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn, nsdecls

def set_cell_margins(cell, top=100, bottom=100, left=150, right=150):
    """Set cell margins (padding) in dxa (1 pt = 20 dxa)"""
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = OxmlElement('w:tcMar')
    for m, val in [('w:top', top), ('w:bottom', bottom), ('w:left', left), ('w:right', right)]:
        node = OxmlElement(m)
        node.set(qn('w:w'), str(val))
        node.set(qn('w:type'), 'dxa')
        tcMar.append(node)
    tcPr.append(tcMar)

def set_table_borders(table, color="707070", sz="4", val="single"):
    """Set full grid borders for a table"""
    tblPr = table._tbl.tblPr
    borders = parse_xml(f'''
        <w:tblBorders {nsdecls('w')}>
            <w:top w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>
            <w:bottom w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>
            <w:left w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>
            <w:right w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>
            <w:insideH w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>
            <w:insideV w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>
        </w:tblBorders>
    ''')
    tblPr.append(borders)

def set_cell_background(cell, fill_hex):
    """Set cell background color"""
    shading = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{fill_hex}"/>')
    cell._tc.get_or_add_tcPr().append(shading)

def add_footer_page_number(run):
    """Insert page number field into footer run"""
    fldChar1 = parse_xml(r'<w:fldChar %s w:fldCharType="begin"/>' % nsdecls('w'))
    instrText = parse_xml(r'<w:instrText %s xml:space="preserve"> PAGE </w:instrText>' % nsdecls('w'))
    fldChar2 = parse_xml(r'<w:fldChar %s w:fldCharType="separate"/>' % nsdecls('w'))
    fldChar3 = parse_xml(r'<w:fldChar %s w:fldCharType="end"/>' % nsdecls('w'))
    run._r.append(fldChar1)
    run._r.append(instrText)
    run._r.append(fldChar2)
    run._r.append(fldChar3)

def create_document(output_path):
    doc = Document()

    # Page setup - Margins (0.75 in)
    section = doc.sections[0]
    section.top_margin = Inches(0.75)
    section.bottom_margin = Inches(0.75)
    section.left_margin = Inches(0.75)
    section.right_margin = Inches(0.75)

    # Footer setup
    footer = section.footer
    footer_p = footer.paragraphs[0]
    footer_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    frun = footer_p.add_run()
    add_footer_page_number(frun)

    # Style configuration
    style = doc.styles['Normal']
    font = style.font
    font.name = 'Nirmala UI'
    font.size = Pt(10.5)
    font.color.rgb = RGBColor(0x11, 0x11, 0x11)

    # -------------------------------------------------------------
    # PAGE 1
    # -------------------------------------------------------------

    # Title & Application Number Box
    top_tbl = doc.add_table(rows=1, cols=2)
    top_tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    top_tbl.autofit = False
    
    c0 = top_tbl.cell(0, 0)
    c0.width = Inches(4.8)
    p0 = c0.paragraphs[0]
    p0.alignment = WD_ALIGN_PARAGRAPH.CENTER
    
    r1 = p0.add_run("මාර්ග ආරක්ෂණ ජනාධිපති සම්මාන - 2026\n")
    r1.bold = True
    r1.font.size = Pt(13)
    
    r2 = p0.add_run("(Presidential Award - 2026)\n")
    r2.bold = True
    r2.font.size = Pt(11.5)
    
    r3 = p0.add_run("සමස්ත ලංකා රියදුරු පාසල් තරඟාවලි අයදුම්පත්‍රය")
    r3.bold = True
    r3.font.size = Pt(11.5)

    c1 = top_tbl.cell(0, 1)
    c1.width = Inches(2.2)
    
    box_tbl = c1.add_table(rows=1, cols=1)
    box_tbl.alignment = WD_TABLE_ALIGNMENT.RIGHT
    b_cell = box_tbl.cell(0, 0)
    b_cell.width = Inches(1.8)
    bp = b_cell.paragraphs[0]
    bp.add_run("අංකය - ").bold = True
    set_cell_margins(b_cell, top=100, bottom=100, left=100, right=100)
    set_table_borders(box_tbl, color="303030", sz="6")

    p_sp = doc.add_paragraph()
    p_sp.paragraph_format.space_before = Pt(6)
    p_sp.paragraph_format.space_after = Pt(6)

    # School Name Input Line
    p_sch = doc.add_paragraph()
    p_sch.paragraph_format.space_after = Pt(12)
    r_sch = p_sch.add_run("රියදුරු පාසලේ නම - ")
    r_sch.bold = True
    p_sch.add_run(".........................................................................................................................")

    # Table 1: Scores summary
    t1_data = [
        ["", "විස්තර", "නිර්දේශිත ලකුණු", "ලබාගත් ලකුණු"],
        ["1", "පෞද්ගලික විස්තර", "", ""],
        ["2", "භෞතික පරිසරය", "", ""],
        ["3", "ව්‍යාපාරයේ ස්වභාවය", "", ""],
        ["4", "උපදේශනය", "", ""],
        ["5", "මාර්ග පුවරු ප්‍රදර්ශනය කිරීම", "", ""],
        ["6", "පුහුණු කිරීමේ කටයුතු", "", ""],
        ["7", "සමාජයට දක්වන දායකත්වය", "", ""],
        ["", "මුළු ලකුණු - ඉලක්කමින්", "", ""],
        ["", "මුළු ලකුණු - වචනයෙන්", "", ""]
    ]

    tbl1 = doc.add_table(rows=len(t1_data), cols=4)
    tbl1.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl1.autofit = False
    set_table_borders(tbl1, color="505050", sz="4")
    col_w1 = [Inches(0.4), Inches(3.6), Inches(1.5), Inches(1.5)]

    for r_idx, row in enumerate(tbl1.rows):
        for c_idx, cell in enumerate(row.cells):
            cell.width = col_w1[c_idx]
            set_cell_margins(cell, top=90, bottom=90, left=100, right=100)
            p = cell.paragraphs[0]
            txt = t1_data[r_idx][c_idx]
            run = p.add_run(txt)
            
            if r_idx == 0:
                run.bold = True
                set_cell_background(cell, "F2F2F2")
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            elif r_idx >= 8:
                run.bold = True
                if c_idx == 1:
                    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
                else:
                    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            else:
                if c_idx == 0 or c_idx >= 2:
                    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                else:
                    p.alignment = WD_ALIGN_PARAGRAPH.LEFT

    p_sp2 = doc.add_paragraph()
    p_sp2.paragraph_format.space_before = Pt(8)
    p_sp2.paragraph_format.space_after = Pt(4)

    # Committee Section 1: පළාත් ඇගයීම් කමිටුව
    p_c1 = doc.add_paragraph()
    p_c1.paragraph_format.space_after = Pt(4)
    r_c1 = p_c1.add_run("පළාත් ඇගයීම් කමිටුව")
    r_c1.bold = True

    t2_data = [
        ["තනතුර", "පළාත් ප්‍රධාන මෝටර් වාහන\nපරීක්ෂක", "දිස්ත්‍රික් ප්‍රධාන මෝටර් වාහන පරීක්ෂක"],
        ["අත්සන", "", ""],
        ["නිල මුද්‍රාව", "", ""]
    ]

    tbl2 = doc.add_table(rows=len(t2_data), cols=3)
    tbl2.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl2.autofit = False
    set_table_borders(tbl2, color="505050", sz="4")
    col_w2 = [Inches(1.8), Inches(2.6), Inches(2.6)]

    for r_idx, row in enumerate(tbl2.rows):
        for c_idx, cell in enumerate(row.cells):
            cell.width = col_w2[c_idx]
            set_cell_margins(cell, top=100, bottom=100, left=100, right=100)
            p = cell.paragraphs[0]
            txt = t2_data[r_idx][c_idx]
            run = p.add_run(txt)
            if r_idx == 0:
                run.bold = True
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                set_cell_background(cell, "F9F9F9")
            else:
                if c_idx == 0:
                    run.bold = True
                p.alignment = WD_ALIGN_PARAGRAPH.LEFT

    p_sp3 = doc.add_paragraph()
    p_sp3.paragraph_format.space_before = Pt(8)
    p_sp3.paragraph_format.space_after = Pt(4)

    # Committee Section 2: අභ්‍යන්තර ඇගයීම් කමිටුව
    p_c2 = doc.add_paragraph()
    p_c2.paragraph_format.space_after = Pt(4)
    r_c2 = p_c2.add_run("අභ්‍යන්තර ඇගයීම් කමිටුව")
    r_c2.bold = True

    t3_data = [
        ["තනතුර", "අතිරේක කොමසාරිස්\nමෝටර් රථ ප්‍රවාහන\nදෙපාර්තමේන්තුව", "සහකාර කොමසාරිස්\nමෝටර් රථ ප්‍රවාහන\nදෙපාර්තමේන්තුව", "ප්‍රධාන මෝටර් වාහන\nපරීක්ෂක කොළඹ"],
        ["අත්සන", "", "", ""],
        ["නිල මුද්‍රාව", "", "", ""]
    ]

    tbl3 = doc.add_table(rows=len(t3_data), cols=4)
    tbl3.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl3.autofit = False
    set_table_borders(tbl3, color="505050", sz="4")
    col_w3 = [Inches(1.4), Inches(1.9), Inches(1.9), Inches(1.8)]

    for r_idx, row in enumerate(tbl3.rows):
        for c_idx, cell in enumerate(row.cells):
            cell.width = col_w3[c_idx]
            set_cell_margins(cell, top=100, bottom=100, left=80, right=80)
            p = cell.paragraphs[0]
            txt = t3_data[r_idx][c_idx]
            run = p.add_run(txt)
            if r_idx == 0:
                run.bold = True
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                set_cell_background(cell, "F9F9F9")
            else:
                if c_idx == 0:
                    run.bold = True
                p.alignment = WD_ALIGN_PARAGRAPH.LEFT

    # End of Page 1
    doc.add_page_break()

    # -------------------------------------------------------------
    # PAGES 2 - 6: Detailed Form Fields Table
    # -------------------------------------------------------------

    main_rows = [
        # (Left col title, list of content blocks)
        ("විස්තරය", [("HEADER", "")]),
        
        ("1 පෞද්ගලික විස්තර", [
            ("TEXT", "1.1 රියදුරු පාසලේ නම (සිංහලෙන්) : ...................................................................................."),
            ("TEXT", "1.2 රියදුරු පාසලේ නම (ඉංග්‍රීසියෙන්) (සහතිකයේ ලිවිය යුතු පරිදි) : ............................................."),
            ("TEXT", "1.2 රියදුරු පාසල් ලියාපදිංචි අංකය : ................................................................................"),
            ("TEXT", "      ශ්‍රේණිය : ............................................................................................................"),
            ("TEXT", "1.3 ලිපිනය : ................................................................................................................."),
            ("TEXT", "1.5 දුරකථන/ ෆැක්ස් : ...................................................................................................."),
            ("TEXT", "1.6 රියදුරු පාසල අයත් ප්‍රාදේශීය ලේකම් කොට්ඨාශය : ..........................................................."),
            ("TEXT", "1.7 දිස්ත්‍රික්කය : ............................................................................................................"),
            ("BOLD_TEXT", "1.8 රියදුරු පාසලේ විස්තර"),
            ("INDENT", "ලියාපදිංචි කළ දිනය : ............................................................................................."),
            ("INDENT", "රියදුරු උපදේශක වරුන් සංඛ්‍යාව : ................................................................................"),
            ("SUB_INDENT", "A ශ්‍රේණිය / B ශ්‍රේණිය / C ශ්‍රේණිය"),
            ("INDENT", "රියදුරු පාසලේ අනෙකුත් සේවක සංඛ්‍යාව : ....................................................................."),
            ("BOLD_TEXT", "1.9 රියදුරු පාසල අයිතිකරූගේ/අයිතිකරුවන්ගේ විස්තර"),
            ("INDENT", "නම ලිපිනය : ........................................................................................................"),
            ("INDENT", "දුරකථන (කාර්යාලය)/ ෆැක්ස් : ...................................................................................."),
            ("INDENT", "ජංගම දුරකථන : ....................................................................................................."),
            ("INDENT", "නිවස : ..................................................................................................................."),
            ("TEXT", "1.10 මෙම අයදුම්පත ක්‍රමානුකූලව හා ආකර්ෂණීය ලෙස ඉදිරිපත් කිරීම."),
            ("TEXT", "1.11 රියදුරු පාසල් දැක්ම හා මෙහෙවර (vision/mission) සහ ව්‍යාපාර නාම ලියාපදිංචි සහතිකය (A4 ප්‍රමාණයේ ඡායා පිටපතක්)")
        ]),

        ("2.ව්‍යාපාරයේ ස්වභාවය", [
            ("TEXT", "2.1 තනි පුද්ගල ව්‍යාපාරයක්ද, හවුල් ව්‍යාපාරයක්ද යන වග."),
            ("TEXT", "2.2 රියදුරු පාසල ලියාපදිංචි කර ඇති දිනය."),
            ("TEXT", "2.3 අදාළ ප්‍රාදේශීය ලේකම් කාර්යාලයෙන් ලබා ගත් ව්‍යාපාර නාම සහතිකය. (ව්‍යාපාර ලියාපදිංචි සහතිකය ප්‍රදර්ශනය කිරීම)"),
            ("TEXT", "2.4 ව්‍යාපාර ස්ථානයේ ඔප්පුව, බදු ඔප්පුව, බදු කුලියන්සී වල පිටපත්."),
            ("TEXT", "2.5 වාහන වල ආදායම් බලපත්‍ර, රක්ෂණ සහතික, වාහන වල ලියාපදිංචි සහතික වල පිටපත්. 2026 වර්ෂය සඳහා වලංගුභාවය පොතක් ලෙස මුද්‍රණය කර ඉදිරිපත් කළ හැක. සාරාංශික සටහන ප්‍රධාන මෝටර් රථ පරීක්ෂක විසින් තහවුරු කළ යුතුයි."),
            ("BOLD_TEXT", "2.6 රියදුරු පාසලේ සංයුතිය."),
            ("BULLET", "රියදුරු පාසලේ සේවක සංඛ්‍යාව"),
            ("BULLET", "රියදුරු උපදේශක සංඛ්‍යාව"),
            ("BULLET", "ඔවුන්ගේ රියදුරු බලපත්‍ර යාවත්කාලීන වීම"),
            ("BULLET", "ඔවුන්ගේ උපදේශන බලපත්‍ර"),
            ("BULLET", "පාසලේ පරීක්ෂණ වාර්තාව (Annual Inspection Report)"),
            ("TEXT", "2.7 කාර්ය මණ්ඩලය සඳහා සුබ සාධන කටයුතු ඉටු කිරීම හා ආයතනය තුළ සහයෝගිතාව ගොඩනැගීමට කිසියම් යාන්ත්‍රණයක් පවත්වා යන්න."),
            ("BOLD_TEXT", "2.8 ආයතනික හා ගිණුම් කටයුතු."),
            ("BULLET", "සේවක පැමිණීමේ ලේඛන, නිවාඩු ලේඛන නිසි පරිදි නඩත්තු කරන්නේද?"),
            ("BULLET", "වැටුප් ගෙවීම පිළිබඳ ලේඛන නිසි පරිදි නඩත්තු කරන්නේද?"),
            ("BULLET", "වාර්ෂික ගිණුම් පොත් පවත්වාගෙන යන්නේද?")
        ]),

        ("3. භෞතික පරිසරය", [
            ("BOLD_TEXT", "3.1 මාර්ග සිතියම"),
            ("INDENT", "ඔබ ආයතනයට කොළඹ සිට පැමිණීමේදී අසන්නතම ප්‍රධාන නගරයේ සිට ළඟා විය හැකි මාර්ග පිළිබඳ දළ සිතියමක් දුර ද ඇතුළත්ව අඳින්න. (A4 Size)"),
            ("BOLD_TEXT", "3.2 රියදුරු පාසල පවත්වාගෙන යනු ලබන ගොඩනැගිල්ල පරීක්ෂා කරනු ලැබේ. දේශන ශාලාව හා කාර්යාලිය වපසරිය බිම් ප්‍රමාණය දැක්වෙන සිතියමක් ඇතුළත් කරන්න (A4 ප්‍රමාණය)"),
            ("BULLET", "ප්‍රායෝගික පුහුණු අංගනයක් (Training Yard) ඇත්නම් එහි තිබිය යුතු නීත්‍යානුකූල තත්වය හා බිම් ප්‍රමාණය (වර්ග මීටර් / පර්චස්) - දල සිතියමක් තිබිය යුතුය."),
            ("BULLET", "වාහන නවතා තැබීමේ ඉඩකඩ තිබිය යුතුය."),
            ("BOLD_TEXT", "3.3 දේශන ශාලා පහසුකම් තිබිය යුතුය."),
            ("BULLET", "නවීන පහසුකම් සහිත දේශන ශාලා. මල්ටිමීඩියා වැනි නවීන උපකරණ භාවිතයෙන් දේශන පැවැත්වීම."),
            ("TEXT", "3.4 පුහුණුවට යොදාගනු ලබන වාහන පිළිබඳ විස්තර ඒ සඳහා ඇමුණුම්හි පරිදි වගුව භාවිත කළ යුතුයි (can be displayed in an A4 sheet)"),
            ("VEHICLE_TABLE", ""),
            ("BOLD_TEXT", "යාන්ත්‍රික දැනුම ලබා ගැනීම සඳහා පහසුකම් තිබේද?"),
            ("BULLET", "Stimulator වැනි උපකරණ මගින් ප්‍රායෝගික දැනුම ලබා දීම"),
            ("BULLET", "වාහන ආකෘති මගින් දැනුම ලබාදීම (vehicle module)"),
            ("BULLET", "සුක්කානම් පද්ධතියක් මගින් දැනුම ලබාදීම"),
            ("BULLET", "වාහන වල ගුණාත්මක භාවය හා පවතින වාහන සංඛ්‍යාව සලකා බැලිය යුතුය."),
            ("BULLET", "පසුගිය අවුරුදු 3 සඳහා වාහන සඳහා ලබාගත් යෝග්‍යතා සටිකර් පරීක්ෂණ අවස්ථාවේ දී ඉදිරිපත් කළ යුතුයි"),
            ("BULLET", "පුහුණු උපදේශක වරුන්ගේ ගුණාත්මකභාවය හා හැකියාව පිළිබඳ සලකා බැලිය යුතුයි."),
            ("BULLET", "ප්‍රායෝගික පුහුණුව සඳහා මාර්ගය භාවිතයට ප්‍රථම පුහුණු අංගනයක් භාවිත කිරීම සහ තමන් සතු පුහුණු අංගනයෙහි වර්ග ප්‍රමාණය (පර්චස් සහ වර්ග මීටර්)"),
            ("BOLD_TEXT", "3.5 ලිපිලේඛන නඩත්තු නිසි පරිදි කර තිබේද?"),
            ("BULLET", "අයදුම්කරුවන්ගෙන් අය කරනු ලබන මුදල් පිළිබඳ තොරතුරු ඇතුළත් මුදල් ලේඛන නිසි පරිදි නඩත්තු කර යුතුයි."),
            ("BULLET", "අයදුම්කරුවන් පිළිබඳ සියලුම මූලික තොරතුරු හා බඳවා ගැනීමේ දින සිට රියදුරු බලපත්‍රය ලබා ගැනීම දක්වා තොරතුරු යාවත්කාලීන විය යුතුයි. ඉහත සියලු අයිතමයන් ලේඛන මගින් තහවුරු කළ යුතුයි."),
            ("DSR_LIST", ""),
            ("BOLD_TEXT", "3.6 බාහිර හා අභ්‍යන්තර අලංකරණය හා පිරිසිදුකම පිළිබඳ සැලකිලිමත් වීම."),
            ("BULLET", "මේ යටතේ සේවාලාභීන්ට හිතකරවන ආකාරයට පරිසරය නිර්මාණය කර තිබීම පරීක්ෂාවට ලක් කරනු ලැබේ.")
        ]),

        ("4 රියදුරු උපදේශනය", [
            ("TEXT", "4.1 රියදුරු උපදේශක විස්තර ඇතුළත්විය යුතුයි. ඒ සඳහා අයදුම්පතෙහි ඇමුණුම 01 පරිදි වගුව භාවිත කළ යුතුයි."),
            ("TEXT", "4.2 සෑම රියදුරු උපදේශකයෙකු විසින්ම සිය උපදේශක බලපත්‍රය අවුරුදු 2කට වරක් අදාළ ගාස්තු ගෙවීම් කර යාවත්කාලීන කර තිබිය යුතුය."),
            ("TEXT", "4.3 පුහුණුව සඳහා යොදා ගන්නා සියළුම වාහන පරීක්ෂා කරනු ලබන අතර ඒවා පහත සඳහන් ප්‍රමිතීන්ට අනුගත බව තහවුරු විය යුතුයි."),
            ("BULLET", "මෝටර් රථ ප්‍රවාහන දෙපාර්තමේන්තුවෙන් වාර්ෂිකව යෝග්‍යතා පරීක්ෂණයෙන් පසුව නිකුත් කරනු ලබන ස්ටිකර් අලවා තිබිය යුතුය. (3.4 වගුව භාවිත කරන්න)")
        ]),

        ("5 රියදුරු පාසල් ප්‍රධාන නාම පුවරුව හා ඇතුළත සංඥා පුවරුව සහ දැන්වීම් ප්‍රදර්ශනය කිරීම", [
            ("TEXT", "5.1 මෝටර් රථ ප්‍රවාහන කොමසාරිස් ජනරාල් තුමාගේ 2024 වක්‍රලේඛය අනුව නියමිත පරිදි භාෂා ත්‍රිත්වයෙන් නාමපුවරු ප්‍රදර්ශනය කර තිබේද යන්න"),
            ("BULLET", "රියදුරු පාසලේ නාමපුවරුව නියමිත පිරිවිතරයන්ට අනුකූලව ප්‍රදර්ශනය කර තිබිය යුතුය. (2024 වක්‍රලේඛය අනුව)"),
            ("BULLET", "මාර්ග නීති හා සංඥා සම්බන්ධ පුවරුවක් එය රියදුරු පාසල තුළ හෝ ප්‍රවේශ වන ස්ථානයේ පැහැදිලිව දැකගත හැකි ආකාරයට සවි කර තිබීම."),
            ("TEXT", "5.2 මාර්ගෝපදේශන සංඥාමය පිටපත් අවශ්‍ය පරිදි තිබේද? (රියදුරු පාසල් පරීක්ෂාවේදී මෙය සංඛ්‍යාත්මකව පරීක්ෂා කරනු ලැබේ.)"),
            ("TEXT", "5.3 රියදුරු පාසලෙහි ගුණාත්මක භාවය අගය කරනු ලබන චක්‍ර මහජන ප්‍රතිචාර පරීක්ෂා කිරීමට පෙට්ටියක් හෝ ආකෘති පත්‍ර උපයෝගී කර ගෙන තිබිය යුතුය"),
            ("TEXT", "5.4 ලොග් පොත නඩත්තු කර තිබිය යුතුය.")
        ]),

        ("6 පුහුණු කිරීමේ කටයුතු", [
            ("TEXT", "6.1 රියදුරු පුහුණුව දේශනය හා කාර්මික දැනුම යන කොටස් දෙකකින් සමන්විත විය යුතුය. දේශන මගින් පුහුණුව සඳහා පුහුණු අත් පොත් හා රියදුරු උපදේශන අත් පොත් භාවිත කරන්නේද යන වග."),
            ("BULLET", "* අත් පොත් ප්‍රමාණය භාෂා ත්‍රිත්වයෙන් (සිංහල / දෙමළ / ඉංග්‍රීසි)"),
            ("TEXT", "6.2 පුහුණුව සම්බන්ධයෙන් ප්‍රමිතයෙන් දේශන ලබා දිය යුතු අතර දේශන සඳහා පහත සඳහන් කරුණු පදනම් විය යුතුය."),
            ("BULLET", "ලිඛිත පරීක්ෂණය සඳහා අවශ්‍ය මාර්ග නීති, යාන්ත්‍රික දැනුම, ආචාර ධර්ම පිළිබඳ ප්‍රශ්න අවබෝධයක් ලබා දිය යුතුය."),
            ("BULLET", "ඒ සඳහා පන්ති කාමර තුළ නවීන උපකරණ භාවිතයෙන් (මල්ටිමීඩියා) අවශ්‍ය දැනුම ලබා දිය යුතුය."),
            ("BULLET", "මෝටර් වාහනයක් ක්‍රියාකාරීත්වය පාලන උපාංග පිළිබඳ පෝස්ටර් අලවා තිබේද ද."),
            ("BULLET", "ලිස්සීයාමෙන් අනතුරු හා ලිස්සීම වලක්වා ගැනීම සඳහා ප්‍රතිකර්ම. තෙත් සහ මීදුම් සහිත කාලගුණ වලදී රිය පැදවීම."),
            ("HIGHWAY_CODE_TABLE", ""),
            ("TEXT", "*සම්පත් දායකයා බාහිර පුද්ගලයෙක් නම් ඔහුගේ සුදුසුකම් පිළිබඳ සහතික ඉදිරිපත් කළ යුතුයි."),
            ("TEXT", "6.3 මාර්ග නීති හා සංඥා සම්බන්ධව පහත සඳහන් පරිදි දැනුවත් වීම කළ යුතුය. අයදුම්කරු බඳවා ගත් දින සිට දෙපාර්තමේන්තු ප්‍රායෝගික පරීක්ෂණය දක්වා වූ සියළු ක්‍රියාකාරකම් අඩංගු විෂය නිර්දේශය ඉදිරිපත් කළ යුතුය. (උපරිමය A4 ප්‍රමාණයේ පිටු දෙකක්)"),
            ("TEXT", "6.4 ලිඛිත පරීක්ෂණ පිළිබඳ තොරතුරු. එය පහත පරිදි වගුවක් ආශ්‍රයෙන් දැක්විය යුතුය. (පසුගිය මාස 06ක විස්තර සපයන්න) DSR-IV පොතෙහි සාරාංශ දැක්වීමක් ලෙස ඉදිරිපත් කළ හැක."),
            ("TEXT", "6.5 ප්‍රායෝගික පුහුණුව සඳහා විෂය නිර්දේශය ඇතුළත් විය යුතු කරුණු. (DSR – II පොතෙහි එම පස ඇලවිය යුතු ප්‍රමුඛ ඉදිරිපත් කළ යුතුය (A4 ප්‍රමාණයේ))"),
            ("TEXT", "6.6 ප්‍රායෝගික පරීක්ෂණ පිළිබඳ තොරතුරු. (වගුවක් ආශ්‍රයෙන් පසුගිය මාස 06ක විස්තර සාරාංශ වාර්තාවක් ලෙස සපයන්න)")
        ]),

        ("7. සමාජයට දක්වන දායකත්වය", [
            ("TEXT", "ජාතික ගැටළුවක් වශයෙන් හඳුනාගෙන ඇති මහා මාර්ග රිය අනතුරු අවම කිරීම සඳහා ඒ පිළිබඳ රියදුරන් සහ සමාජයේ අනෙකුත් කොටස් දැනුවත් කිරීම තුළින් එම ජාතික ගැටළුව අවම කිරීම සඳහා දායකත්වයක් ලබා දෙන්නේ ද ඒ පිළිබඳ විස්තර ඉදිරිපත් කළයුතුය.")
        ])
    ]

    master_tbl = doc.add_table(rows=len(main_rows), cols=2)
    master_tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    master_tbl.autofit = False
    set_table_borders(master_tbl, color="505050", sz="4")

    col_wm = [Inches(1.8), Inches(5.2)]

    for r_idx, (cat_title, blocks) in enumerate(main_rows):
        row = master_tbl.rows[r_idx]
        
        # Left Cell: Category Name
        cl = row.cells[0]
        cl.width = col_wm[0]
        set_cell_margins(cl, top=100, bottom=100, left=100, right=100)
        pl = cl.paragraphs[0]
        rl = pl.add_run(cat_title)
        rl.bold = True

        # Right Cell: Content
        cr = row.cells[1]
        cr.width = col_wm[1]
        set_cell_margins(cr, top=100, bottom=100, left=100, right=100)

        if r_idx == 0:
            set_cell_background(cl, "F0F0F0")
            set_cell_background(cr, "F0F0F0")
            continue

        p_count = 0
        for b_type, b_content in blocks:
            if p_count == 0:
                p = cr.paragraphs[0]
            else:
                p = cr.add_paragraph()
            p_count += 1

            p.paragraph_format.space_before = Pt(3)
            p.paragraph_format.space_after = Pt(3)

            if b_type == "TEXT":
                p.add_run(b_content)
            elif b_type == "BOLD_TEXT":
                r = p.add_run(b_content)
                r.bold = True
            elif b_type == "INDENT":
                p.paragraph_format.left_indent = Inches(0.2)
                p.add_run(b_content)
            elif b_type == "SUB_INDENT":
                p.paragraph_format.left_indent = Inches(0.4)
                p.add_run(b_content)
            elif b_type == "BULLET":
                p.paragraph_format.left_indent = Inches(0.2)
                p.add_run("•  " + b_content)
            elif b_type == "DSR_LIST":
                dsr_items = ["DSR 1", "DSR 2", "DSR 3", "DSR 4", "DSR 5"]
                for i_idx, dsr_item in enumerate(dsr_items):
                    if i_idx > 0:
                        p_sub = cr.add_paragraph()
                        p_count += 1
                    else:
                        p_sub = p
                    p_sub.paragraph_format.left_indent = Inches(0.2)
                    p_sub.paragraph_format.space_before = Pt(1)
                    p_sub.paragraph_format.space_after = Pt(1)
                    p_sub.add_run(dsr_item)

            elif b_type == "VEHICLE_TABLE":
                v_headers = ["Vehicle Category", "Regi/ No.", "Sticker No & year"]
                v_rows = [
                    ["A1", "", ""],
                    ["A", "", ""],
                    ["B", "", ""],
                    ["B1", "", ""],
                    ["D", "", ""],
                    ["CE", "", ""],
                    ["G", "", ""]
                ]
                v_tbl = cr.add_table(rows=len(v_rows) + 1, cols=3)
                v_tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
                set_table_borders(v_tbl, color="707070", sz="4")
                v_w = [Inches(1.5), Inches(1.5), Inches(1.8)]

                # Header
                for c_idx, h_text in enumerate(v_headers):
                    cell = v_tbl.cell(0, c_idx)
                    cell.width = v_w[c_idx]
                    set_cell_margins(cell, top=60, bottom=60, left=80, right=80)
                    vp = cell.paragraphs[0]
                    vr = vp.add_run(h_text)
                    vr.bold = True
                    vp.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    set_cell_background(cell, "F5F5F5")

                # Data rows
                for r_i, r_data in enumerate(v_rows):
                    for c_i, val in enumerate(r_data):
                        cell = v_tbl.cell(r_i + 1, c_i)
                        cell.width = v_w[c_i]
                        set_cell_margins(cell, top=50, bottom=50, left=80, right=80)
                        vp = cell.paragraphs[0]
                        vr = vp.add_run(val)
                        if c_i == 0:
                            vr.bold = True
                            vp.alignment = WD_ALIGN_PARAGRAPH.CENTER

            elif b_type == "HIGHWAY_CODE_TABLE":
                p.add_run("Number of Highway Code awareness programs conducted").bold = True
                p.paragraph_format.space_after = Pt(4)

                h_headers = ["Name of Resources person", "Number of programs"]
                h_rows = [
                    ["Daily", ""],
                    ["Weekly", ""],
                    ["Monthly", ""]
                ]
                h_tbl = cr.add_table(rows=len(h_rows) + 1, cols=2)
                h_tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
                set_table_borders(h_tbl, color="707070", sz="4")
                h_w = [Inches(2.8), Inches(1.8)]

                for c_idx, h_text in enumerate(h_headers):
                    cell = h_tbl.cell(0, c_idx)
                    cell.width = h_w[c_idx]
                    set_cell_margins(cell, top=60, bottom=60, left=80, right=80)
                    hp = cell.paragraphs[0]
                    hr = hp.add_run(h_text)
                    hr.bold = True
                    hp.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    set_cell_background(cell, "F5F5F5")

                for r_i, r_data in enumerate(h_rows):
                    for c_i, val in enumerate(r_data):
                        cell = h_tbl.cell(r_i + 1, c_i)
                        cell.width = h_w[c_i]
                        set_cell_margins(cell, top=50, bottom=50, left=80, right=80)
                        hp = cell.paragraphs[0]
                        hp.add_run(val)

    # End of Form Section
    doc.add_page_break()

    # -------------------------------------------------------------
    # PAGE 7: ඇමුණුම - 01 (Instructors' details & Asst. Instructors' details)
    # -------------------------------------------------------------

    p_ann1 = doc.add_paragraph()
    p_ann1.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    r_ann1 = p_ann1.add_run("ඇමුණුම - 01")
    r_ann1.bold = True

    p_it = doc.add_paragraph()
    r_it = p_it.add_run("Instructors' details")
    r_it.bold = True
    r_it.font.size = Pt(11.5)

    inst_h = ["Name", "Age", "DI Category\n(A/B/C)", "DI Number", "Validity"]
    inst_w = [Inches(2.2), Inches(0.8), Inches(1.4), Inches(1.3), Inches(1.3)]

    tbl_inst = doc.add_table(rows=9, cols=5)
    tbl_inst.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(tbl_inst, color="505050", sz="4")

    for r_i, row in enumerate(tbl_inst.rows):
        for c_i, cell in enumerate(row.cells):
            cell.width = inst_w[c_i]
            set_cell_margins(cell, top=70, bottom=70, left=80, right=80)
            p = cell.paragraphs[0]
            if r_i == 0:
                run = p.add_run(inst_h[c_i])
                run.bold = True
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                set_cell_background(cell, "F2F2F2")

    p_sp4 = doc.add_paragraph()
    p_sp4.paragraph_format.space_before = Pt(12)

    p_at = doc.add_paragraph()
    r_at = p_at.add_run("Asst. Instructors' details")
    r_at.bold = True
    r_at.font.size = Pt(11.5)

    asst_h = ["Name", "Age", "ADI Category\n(A/B/C)", "ADI Number", "Validity"]

    tbl_asst = doc.add_table(rows=9, cols=5)
    tbl_asst.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(tbl_asst, color="505050", sz="4")

    for r_i, row in enumerate(tbl_asst.rows):
        for c_i, cell in enumerate(row.cells):
            cell.width = inst_w[c_i]
            set_cell_margins(cell, top=70, bottom=70, left=80, right=80)
            p = cell.paragraphs[0]
            if r_i == 0:
                run = p.add_run(asst_h[c_i])
                run.bold = True
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                set_cell_background(cell, "F2F2F2")

    # End of Page 7
    doc.add_page_break()

    # -------------------------------------------------------------
    # PAGE 8: ඇමුණුම 02 (Training Certificates)
    # -------------------------------------------------------------

    p_ann2 = doc.add_paragraph()
    p_ann2.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    r_ann2 = p_ann2.add_run("ඇමුණුම 02")
    r_ann2.bold = True

    p_ct = doc.add_paragraph()
    r_ct = p_ct.add_run("Number of Training Certificate obtained and Issued to the trainees")
    r_ct.bold = True
    r_ct.font.size = Pt(11.5)

    cert_rows = [
        ("Month", "Obtained amount Serial Number", "Issued"),
        ("2025", "", ""),
        ("January", "", ""),
        ("February", "", ""),
        ("March", "", ""),
        ("April", "", ""),
        ("May", "", ""),
        ("June", "", ""),
        ("July", "", ""),
        ("August", "", ""),
        ("September", "", ""),
        ("October", "", ""),
        ("November", "", ""),
        ("December", "", ""),
        ("2026", "", ""),
        ("January", "", ""),
        ("February", "", ""),
        ("March", "", ""),
        ("April", "", ""),
        ("May", "", ""),
        ("June", "", ""),
        ("July", "", ""),
        ("August", "", "")
    ]

    tbl_cert = doc.add_table(rows=len(cert_rows), cols=3)
    tbl_cert.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(tbl_cert, color="505050", sz="4")

    cert_w = [Inches(1.8), Inches(3.2), Inches(2.0)]

    for r_i, (m_val, s_val, i_val) in enumerate(cert_rows):
        row = tbl_cert.rows[r_i]
        for c_i, val in enumerate([m_val, s_val, i_val]):
            cell = row.cells[c_i]
            cell.width = cert_w[c_i]
            set_cell_margins(cell, top=60, bottom=60, left=80, right=80)
            p = cell.paragraphs[0]
            run = p.add_run(val)
            
            if r_i == 0:
                run.bold = True
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                set_cell_background(cell, "F2F2F2")
            elif val in ["2025", "2026"]:
                run.bold = True
                p.alignment = WD_ALIGN_PARAGRAPH.LEFT
                set_cell_background(cell, "FAFAFA")
            else:
                p.alignment = WD_ALIGN_PARAGRAPH.LEFT

    # Save final docx
    doc.save(output_path)
    print(f"File created successfully at {output_path}")

if __name__ == "__main__":
    target_docx = r"d:\Projects\payroll-system\ Presidential_Award_2026_Application.docx".strip()
    target_docx_clean = r"d:\Projects\payroll-system\Presidential_Award_2026_Application.docx"
    create_document(target_docx_clean)
