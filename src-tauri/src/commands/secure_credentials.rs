//! Isolated access to Windows' native credential vault.

use keyring::Entry;

const SERVICE: &str = "UE-Launcher-CommandHelper-GitHub";
const ACCOUNT: &str = "oauth-token";

pub fn read_token() -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn write_token(token: &str) -> Result<(), String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|error| error.to_string())?.set_password(token).map_err(|error| error.to_string())
}

pub fn delete_token() -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn credential_service_name_does_not_contain_a_token() {
        assert!(!super::SERVICE.contains("token-value"));
    }
}