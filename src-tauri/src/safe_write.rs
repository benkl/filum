//! Saving without risking the file that is already there: the bytes go to a
//! temporary file in the same folder, are flushed to the disk, and only then
//! replace the old file in one rename. A save cut off by a crash, a full disk
//! or a pulled cable leaves the old file whole (and at most the temporary
//! file next to it, reused by the next save).

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// The temporary file a save of `target` writes first: `.<name>.saving`, next to it.
fn temporary(target: &Path) -> Option<PathBuf> {
    let name = target.file_name()?.to_string_lossy();
    Some(target.with_file_name(format!(".{name}.saving")))
}

/// Writes `bytes` to `path`, replacing the file only once they are all on the disk.
pub fn write_replacing(path: &Path, bytes: &[u8]) -> io::Result<()> {
    // a link is followed: the file it points to is replaced, not the link
    let target = match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(path)?,
        _ => path.to_path_buf(),
    };
    let old = fs::metadata(&target).ok();
    // a read-only file stays read-only (a rename would replace it anyway on some systems)
    if old.as_ref().is_some_and(|m| m.is_file() && m.permissions().readonly()) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("{} is read-only", target.display())));
    }
    let Some(tmp) = temporary(&target) else { return fs::write(&target, bytes) };
    let mut file = match File::create(&tmp) {
        Ok(f) => f,
        // a folder where only the file itself may be written: write it in place
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => return fs::write(&target, bytes),
        Err(e) => return Err(e),
    };
    let written = (|| {
        file.write_all(bytes)?;
        // the old file's mode carries over (a new file would get the defaults;
        // on Windows the folder's access rules apply to both alike)
        #[cfg(unix)]
        if let Some(m) = old.as_ref().filter(|m| m.is_file()) {
            file.set_permissions(m.permissions())?;
        }
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, &target)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written?;
    // the rename itself is on the disk once the folder is
    #[cfg(unix)]
    if let Some(dir) = target.parent() {
        let _ = File::open(if dir.as_os_str().is_empty() { Path::new(".") } else { dir }).and_then(|d| d.sync_all());
    }
    Ok(())
}

/// The file name the editor sends, percent-encoded so any name fits in a header.
pub fn decode_path(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("filum-safe-write-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_save_replaces_the_file_and_leaves_nothing_behind() {
        let d = folder("replace");
        let f = d.join("Mountain badge.filum");
        fs::write(&f, b"old").unwrap();
        write_replacing(&f, b"new design").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"new design");
        let names: Vec<_> = fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1, "{names:?}");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_new_file_is_written_and_a_leftover_is_reused() {
        let d = folder("new");
        let f = d.join("new.pes");
        fs::write(temporary(&f).unwrap(), b"cut off by a crash").unwrap();
        write_replacing(&f, b"stitches").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"stitches");
        assert!(!temporary(&f).unwrap().exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_failed_save_keeps_the_old_file() {
        let d = folder("fail");
        // the target is a folder: the rename fails, and the folder and its content stay
        let f = d.join("taken");
        fs::create_dir(&f).unwrap();
        fs::write(f.join("inside"), b"keep").unwrap();
        assert!(write_replacing(&f, b"x").is_err());
        assert_eq!(fs::read(f.join("inside")).unwrap(), b"keep");
        assert!(!temporary(&f).unwrap().exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    #[allow(clippy::permissions_set_readonly_false)]
    fn a_read_only_file_is_not_replaced() {
        let d = folder("readonly");
        let f = d.join("locked.dst");
        fs::write(&f, b"keep").unwrap();
        let mut p = fs::metadata(&f).unwrap().permissions();
        p.set_readonly(true);
        fs::set_permissions(&f, p.clone()).unwrap();
        assert_eq!(write_replacing(&f, b"x").unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&f).unwrap(), b"keep");
        p.set_readonly(false);
        fs::set_permissions(&f, p).unwrap();
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn names_are_decoded() {
        assert_eq!(decode_path("C%3A%5CUsers%5Cb%C3%BCro%5Ca%20b.filum").as_deref(), Some("C:\\Users\\büro\\a b.filum"));
        assert_eq!(decode_path("/home/x.dst").as_deref(), Some("/home/x.dst"));
        assert_eq!(decode_path("bad%2"), None);
        assert_eq!(decode_path("bad%zz"), None);
    }
}
