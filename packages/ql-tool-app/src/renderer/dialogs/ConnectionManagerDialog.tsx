import { useEffect, useState } from "react"
import Alert from "@mui/material/Alert"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import Dialog from "@mui/material/Dialog"
import DialogActions from "@mui/material/DialogActions"
import DialogContent from "@mui/material/DialogContent"
import DialogTitle from "@mui/material/DialogTitle"
import List from "@mui/material/List"
import ListItemButton from "@mui/material/ListItemButton"
import ListItemText from "@mui/material/ListItemText"
import TextField from "@mui/material/TextField"

import { ConnectionProfileForm, type ConnectionProfile } from "@wireio/ql-shared"

import {
  removeProfile,
  saveProfile,
  setDefaultProfile,
  testConnection,
  UiActions,
  UiSurface,
  useAppDispatch,
  useAppSelector,
  useSurface
} from "../store/index.js"

/**
 * Connection manager: list / add / edit / delete / set default, and "Test
 * connection" (ABI of the first owner + LIMIT 0 describe of its first table,
 * through the query host). Profiles hold an endpoint and tuning only — nothing secret;
 * the form fields and their validation are the shared `ConnectionProfileForm`.
 *
 * @returns The dialog.
 */
export function ConnectionManagerDialog() {
  const dispatch = useAppDispatch(),
    open = useSurface(UiSurface.connections),
    document = useAppSelector(state => state.connections.document),
    [form, setForm] = useState<ConnectionProfileForm>(ConnectionProfileForm.empty()),
    [message, setMessage] = useState<string>(null),
    close = () => dispatch(UiActions.surfaceClosed(UiSurface.connections)),
    field = (key: keyof ConnectionProfileForm, label: string) => (
      <TextField
        label={label}
        value={form[key]}
        fullWidth
        margin="dense"
        slotProps={{ htmlInput: { "aria-label": label } }}
        onChange={event => setForm({ ...form, [key]: event.target.value })}
      />
    ),
    withProfile = (action: (profile: ConnectionProfile) => void) =>
      ConnectionProfileForm.toProfile(form).match({ Left: setMessage, Right: action })
  useEffect(() => {
    if (open) setMessage(null)
  }, [open])
  return (
    <Dialog open={open} onClose={close} maxWidth="md" fullWidth>
      <DialogTitle>Connections</DialogTitle>
      <DialogContent sx={{ display: "flex", gap: 2 }}>
        <List dense sx={{ width: 200, borderRight: 1, borderColor: "divider" }}>
          <ListItemButton onClick={() => setForm(ConnectionProfileForm.empty())}>
            <ListItemText primary="New connection…" />
          </ListItemButton>
          {document.profiles.map(profile => (
            <ListItemButton key={profile.name} selected={profile.name === form.name} onClick={() => setForm(ConnectionProfileForm.of(profile))}>
              <ListItemText primary={profile.name} secondary={profile.name === document.defaultProfile ? "default" : profile.endpoint} />
            </ListItemButton>
          ))}
        </List>
        <Box sx={{ flex: 1 }}>
          {field("name", "Name")}
          {field("endpoint", "Endpoint URL")}
          {field("transportTimeoutMs", "Transport timeout (ms)")}
          {field("queryTimeoutMs", "Server timeout (ms)")}
          {field("retries", "Retries")}
          {field("owners", "Owners (comma separated)")}
          {message != null && (
            <Alert severity="info" data-testid="connection-message" sx={{ mt: 1 }}>
              {message}
            </Alert>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => withProfile(profile => void dispatch(testConnection(profile)).then(setMessage))}>Test connection</Button>
        <Button
          disabled={!document.profiles.some(profile => profile.name === form.name)}
          onClick={() => void dispatch(removeProfile(form.name)).then(() => setForm(ConnectionProfileForm.empty()))}
        >
          Delete
        </Button>
        <Button
          disabled={!document.profiles.some(profile => profile.name === form.name)}
          onClick={() => void dispatch(setDefaultProfile(form.name))}
        >
          Set default
        </Button>
        <Button onClick={close}>Close</Button>
        <Button variant="contained" onClick={() => withProfile(profile => void dispatch(saveProfile(profile)).then(() => setMessage(`Saved ${profile.name}`)))}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  )
}
