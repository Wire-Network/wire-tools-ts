import List from "@mui/material/List"
import ListItem from "@mui/material/ListItem"
import ListItemText from "@mui/material/ListItemText"

import { MessageSeverity, type ResultMessage } from "../store/index.js"

/** Props of {@link MessagesView}. */
export interface MessagesViewProps {
  /** The tab's message log. */
  messages: ResultMessage[]
}

/**
 * The action output log of a result tab (runs, pages, outcomes).
 *
 * @param props - The messages.
 * @returns The list.
 */
export function MessagesView({ messages }: MessagesViewProps) {
  return (
    <List dense data-testid="messages-view">
      {messages.map((message, index) => (
        <ListItem key={`${message.at}-${index}`}>
          <ListItemText
            primary={message.text}
            secondary={message.at}
            slotProps={{
              primary: { color: message.severity === MessageSeverity.error ? "error" : "textPrimary" }
            }}
          />
        </ListItem>
      ))}
    </List>
  )
}
