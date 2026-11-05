# FAQ and troubleshooting

## General

**Is Filum free?**
Yes. It's open source under the GPL-3.0-or-later, the same licence as Ink/Stitch, whose algorithms it builds on.

**Which embroidery machines does it work with?**
Any machine that reads one of its formats. That covers Brother and Baby Lock (PES), Janome and Elna (JEF), Tajima and most commercial machines (DST), Melco and Bernina (EXP), Pfaff and Husqvarna Viking (VP3), Singer (XXX), Barudan (U01) and more. See [Export and print](Export-and-Print.md).

**Can I open my Ink/Stitch designs?**
Yes. Ink/Stitch SVGs open with their stitch settings, and **File → Export Ink/Stitch SVG** goes the other way.

**Can I open embroidery files I bought?**
Filum reads 40 machine formats. Machine files only contain stitches, not shapes, so you can recolour, resize a little, combine and re-export them. For real editing, **Path → Convert → Rebuild shapes from stitches…** turns the stitches back into editable shapes.

**Does the AI in the digitizer send my pictures anywhere?**
No. The models are bundled with Filum and run on your own computer. See [Auto-digitize](Auto-Digitize.md#on-device-ai).

**Can I sell designs made with the bundled fonts?**
The bundled ones, yes, within their licences (SIL OFL, Creative Commons BY / BY-SA / BY-ND or public domain). **Help → Licences** lists every font with its licence. The eight non-commercial fonts aren't bundled. If you download them in **Preferences → Downloads**, you accept their licence (CC BY-NC-SA 4.0), which rules out commercial use.

**Why are some fonts and thread charts a separate download?**
Filum only includes content it may share with everyone, including people who sell or redistribute it. Eight fonts allow only non-commercial use, and the Embroidery Nerds thread charts have no licence at all, so they can't be part of Filum. **Preferences → Downloads** shows each one's licence, and one click downloads it from its author to your device. Nothing else changes: they then work like the bundled ones.

## Saving

**Where is my work saved?**
In the desktop app, **Save** writes a `.filum` file wherever you choose, and saves back to it next time. In the browser, Filum also **autosaves** the current design in the browser's storage, so it's still there when you come back. Autosave can be turned off, and the autosaved design cleared, under **Preferences → Files & data**. Save a `.filum` file for anything you want to keep.

**I exported a PES/DST. Why can't I edit my lettering in it any more?**
Machine files hold only stitches. Keep the `.filum` project. It keeps every shape, setting and text editable.

## On the machine

**My machine doesn't show the design, or rejects the file.**
- Check that the design fits your machine's hoop. The Export dialog warns you if it doesn't.
- Pick the format your machine expects. For PES, try **PES version v1 · Brother colours**, which every Brother machine reads.
- Some formats limit the number of colours. SEW is one, and the pre-flight check suggests merging colours or using JEF.
- Choose the right machine in the Export dialog's **Machine** section.

**The colours on my machine's screen are different.**
PES v1 describes colours as entries of Brother's thread table, so the machine shows the nearest Brother thread. Use **PES v6 · exact threads** to store your actual threads (newer machines only). DST stores no colours at all.

**The stitching puckers or the fabric shows through.**
- Choose the right **Fabric** preset in the title bar. It sets density, underlay and pull compensation for that fabric.
- Check the **Density map** (<kbd>Shift</kbd>+<kbd>D</kbd>) for areas that are too dense.
- Use the recommended **backing** and **topping** (**Design → Fabric & thread**).
- **Calibrate the fabric** (the ruler button next to the fabric): sew one swatch, measure it, and new objects start from the pull compensation your setup needs (see [Production tools](Production-Tools.md#calibrate-a-fabric)).
- Sew **Test swatches** with a few densities or pull compensations and keep the best (see [Production tools](Production-Tools.md)).
- On towels and fleece, add **Knockdown** stitches.

**Small text looks messy.**
Use a pre-digitized embroidery font made for small sizes, and a finer thread. The **Issues** tab warns you about lettering too small for your thread, and **Design → Fabric & thread** shows the smallest recommended text.

## The app

**How do I find a command?**
Press <kbd>Ctrl</kbd>+<kbd>K</kbd> and type. Press <kbd>?</kbd> for every keyboard shortcut.

**Something looks wrong. How do I reset Filum?**
**Preferences → Editing → Reset every tool's settings**, **Preferences → Digitizer → Reset digitizer settings** and **Preferences → Files & data → Reset preferences** each reset one area. **View → Panels → Reset panel layout** puts the panels back where they started.

**Is the browser version different from the desktop app?**
They do the same things. A few features depend on the browser: the **System fonts** tab needs a browser that can list local fonts, and **Video** needs one that can record (MediaRecorder). The desktop app uses your system's file dialogs, saves straight back to your file, and opens designs and pictures you double-click or open with Filum.

**Is there a phone or tablet version?**
Not yet. Tauri can build for Android and iOS, but the mobile apps are still experimental.

**I found a bug or have an idea.**
Please open an issue on GitHub, with the design file if you can.
