use std::io;
/// Disable each confirmed owned service before inspecting the next service.
pub fn clear_owned_services(
    services:&[String], mut owned:impl FnMut(&str)->io::Result<bool>,
    mut clear:impl FnMut(&str)->io::Result<()>,
)->io::Result<()> {
    let mut first_error=None;
    for service in services {
        let result=match owned(service){Ok(true)=>clear(service),Ok(false)=>Ok(()),Err(error)=>Err(error)};
        if let Err(error)=result{if first_error.is_none(){first_error=Some(error);}}
    }
    first_error.map_or(Ok(()),Err)
}
#[cfg(test)]
mod tests {
    use super::*;use std::cell::RefCell;
    #[test]
    fn later_inspection_failure_preserves_earlier_cleanup(){
        let events=RefCell::new(Vec::new());
        let result=clear_owned_services(&["Wi-Fi".into(),"Ethernet".into()],|name|{
            events.borrow_mut().push(format!("inspect:{name}"));
            if name=="Ethernet"{Err(io::Error::new(io::ErrorKind::TimedOut,"slow service"))}else{Ok(true)}
        },|name|{events.borrow_mut().push(format!("clear:{name}"));Ok(())});
        assert!(result.is_err());assert_eq!(*events.borrow(),vec!["inspect:Wi-Fi","clear:Wi-Fi","inspect:Ethernet"]);
    }
}
